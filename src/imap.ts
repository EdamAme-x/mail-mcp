import { failure, MailFault } from './result.js'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { type ImapCredentials } from './accounts.js'
import { type CredentialStore } from './store.js'
import { type MailProvider, type Search } from './mail.js'

const maxMessageBytes = 10 * 1024 * 1024
// Including UIDVALIDITY prevents a stale ID from resolving to a different message.
function decodeId(value: string) {
  if (!/^\d+:\d+$/.test(value)) throw new MailFault(failure('INVALID_INPUT'))
  const [validity, uid] = value.split(':')
  const number = Number(uid)
  if (!Number.isSafeInteger(number) || number < 1 || number > 0xffffffff) throw new MailFault(failure('INVALID_INPUT'))
  return { validity, uid: number }
}

export class Imap implements MailProvider {
  constructor(private store: CredentialStore<ImapCredentials>, private factory = (options: ConstructorParameters<typeof ImapFlow>[0]) => new ImapFlow(options)) {}

  private async connected<T>(action: (client: ImapFlow, validity: string) => Promise<T>): Promise<T> {
    const credentials = await this.store.read()
    const client = this.factory({ host: credentials.host, port: credentials.port, secure: true, auth: { user: credentials.user, pass: credentials.password }, logger: false, disableAutoIdle: true, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 })
    let connectionError: unknown
    client.on('error', error => { connectionError = error })
    try {
      await client.connect()
      const lock = await client.getMailboxLock(credentials.mailbox, { readOnly: true })
      try {
        if (!client.mailbox) throw new MailFault(failure('NOT_FOUND'))
        const result = await action(client, String(client.mailbox.uidValidity))
        if (connectionError) throw connectionError
        return result
      } finally { lock.release() }
    } finally { client.close() }
  }

  async check() { await this.connected(async () => undefined) }

  async list({ text, limit = 20, pageToken }: Search) {
    return this.connected(async (client, validity) => {
      const cursor = pageToken ? decodeId(pageToken) : undefined
      if (cursor && cursor.validity !== validity) throw new MailFault(failure('STALE_CURSOR'))
      if (cursor?.uid === 1) return { messages: [] }
      const found = await client.search({ ...(text ? { text } : { all: true }), ...(cursor ? { uid: `1:${cursor.uid - 1}` } : {}) }, { uid: true })
      if (!Array.isArray(found)) throw new MailFault(failure('INVALID_RESPONSE'))
      const uids = found.sort((a, b) => b - a)
      const selected = uids.slice(0, limit)
      if (!selected.length) return { messages: [] }
      const fetched = await client.fetchAll(selected, { uid: true, envelope: true, internalDate: true, flags: true }, { uid: true })
      const messages = fetched.sort((a, b) => b.uid - a.uid).map(m => ({ id: `${validity}:${m.uid}`, subject: m.envelope?.subject, from: m.envelope?.from?.map(a => a.address).join(', '), date: m.internalDate instanceof Date ? m.internalDate.toISOString() : undefined, unread: !m.flags?.has('\\Seen') }))
      return { messages, nextPageToken: uids.length > limit ? `${validity}:${selected.at(-1)}` : undefined }
    })
  }

  async get(id: string) {
    const messageId = decodeId(id)
    return this.connected(async (client, validity) => {
      if (messageId.validity !== validity) throw new MailFault(failure('STALE_CURSOR'))
      const metadata = await client.fetchOne(String(messageId.uid), { size: true, uid: true }, { uid: true })
      if (!metadata) throw new MailFault(failure('NOT_FOUND'))
      if ((metadata.size ?? 0) > maxMessageBytes) throw new MailFault(failure('TOO_LARGE'))
      const m = await client.fetchOne(String(messageId.uid), { source: { maxLength: maxMessageBytes + 1 }, flags: true }, { uid: true })
      if (!m || !m.source) throw new MailFault(failure('NOT_FOUND'))
      if (m.source.length > maxMessageBytes) throw new MailFault(failure('TOO_LARGE'))
      const parsed = await simpleParser(m.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true })
      const to = Array.isArray(parsed.to) ? parsed.to.map(a => a.text).join(', ') : parsed.to?.text
      return { id, subject: parsed.subject, from: parsed.from?.text, to, date: parsed.date?.toISOString(), unread: !m.flags?.has('\\Seen'), text: parsed.text ?? '', html: parsed.html || '', attachments: parsed.attachments.map(a => ({ filename: a.filename ?? '', mimeType: a.contentType, size: a.size })) }
    })
  }
}
