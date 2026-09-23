import { Accounts, type Account, type Provider } from './accounts.js'
import { Gmail } from './gmail.js'
import { Imap } from './imap.js'
import { Outlook } from './outlook.js'
import { mapLimit, type MailProvider, type Summary } from './mail.js'

export type ListInput = { accounts?: string[]; text?: string; query?: string; limit?: number; pageToken?: string; pageTokens?: Record<string, string> }
export type MessageRef = { account?: string; id: string }
const failure = 'Could not read this account. Check its login, connection, and search/page token. IMAP messages must be at most 10 MiB.'

export class MailService {
  private clients = new Map<string, { provider: Provider; client: MailProvider }>()
  constructor(private accounts: Accounts, private factory?: (id: string, account: Account) => MailProvider) {}

  private async client(id: string) {
    const account = await this.accounts.read(id)
    const cached = this.clients.get(id)
    if (cached?.provider === account.provider) return cached
    let client: MailProvider
    if (this.factory) client = this.factory(id, account)
    else if (account.provider === 'gmail') {
      const gmail = new Gmail(this.accounts.credentials(id, 'gmail'))
      client = { list: input => gmail.search(input), get: id => gmail.get(id) }
    } else if (account.provider === 'outlook') client = new Outlook(this.accounts.credentials(id, 'outlook'))
    else client = new Imap(this.accounts.credentials(id, 'imap'))
    const value = { provider: account.provider, client }
    this.clients.set(id, value)
    return value
  }

  async listAccounts() {
    return Promise.all((await this.accounts.ids()).map(async id => {
      try {
        const account = await this.accounts.read(id)
        return { account: id, provider: account.provider, ...(account.provider === 'imap' ? { mailbox: account.credentials.mailbox } : {}) }
      } catch { return { account: id, error: 'Credentials are invalid. Log in again.' } }
    }))
  }

  async list(input: ListInput) {
    if (input.text && input.query) throw new Error('Use text for cross-provider search, or query for one Gmail account.')
    if (input.pageToken && input.pageTokens) throw new Error('Use pageToken or pageTokens, not both.')
    const selected = [...new Set(input.accounts ?? (input.pageTokens ? Object.keys(input.pageTokens) : await this.accounts.ids()))]
    if (input.query || input.pageToken) {
      if (selected.length !== 1) throw new Error('query and pageToken require exactly one selected account.')
      if (input.query && (await this.accounts.read(selected[0]!)).provider !== 'gmail') throw new Error('query is Gmail-only. Use text for cross-provider search.')
    }
    if (input.pageTokens && selected.some(id => !Object.hasOwn(input.pageTokens!, id))) throw new Error('Every selected account needs a page token when continuing a search.')
    const messages: (Summary & { account: string; provider: Provider })[] = []
    const errors: { account: string; error: string }[] = []
    const nextPageTokens: Record<string, string> = Object.create(null)
    await mapLimit(selected, 4, async id => {
      try {
        const { client, provider } = await this.client(id)
        const page = await client.list({ text: input.text, query: input.query, limit: input.limit ?? 20, pageToken: input.pageTokens?.[id] ?? input.pageToken })
        messages.push(...page.messages.map(m => ({ ...m, account: id, provider })))
        if (page.nextPageToken) nextPageTokens[id] = page.nextPageToken
      } catch { errors.push({ account: id, error: failure }) }
    })
    const timestamp = (date?: string) => date ? Date.parse(date) || 0 : 0
    messages.sort((a, b) => timestamp(b.date) - timestamp(a.date) || a.account.localeCompare(b.account) || a.id.localeCompare(b.id))
    return { messages, nextPageTokens, errors }
  }

  async get({ account, id }: MessageRef) {
    if (!account) {
      const ids = await this.accounts.ids()
      if (ids.length !== 1) throw new Error('Specify account when more than one account is registered.')
      account = ids[0]!
    }
    try {
      const { client, provider } = await this.client(account)
      return { account, provider, message: await client.get(id) }
    } catch { throw new Error(failure) }
  }

  async getMany(references: (MessageRef & { account: string })[]) {
    return mapLimit(references, 4, async ref => {
      try { return { id: ref.id, ...await this.get(ref) } }
      catch { return { account: ref.account, id: ref.id, error: failure } }
    })
  }
}
