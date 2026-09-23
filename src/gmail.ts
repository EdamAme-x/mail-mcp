import { z } from 'zod'
import { authorizedJson, checkedJson, send } from './http.js'
import { TokenSession } from './session.js'
import { failure, MailFault, valueOrThrow } from './result.js'
import { type CredentialStore, type Credentials } from './store.js'
import { mapLimit, type Search } from './mail.js'

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
})

export async function exchangeToken(parameters: Record<string, string>, fetcher: typeof fetch = fetch) {
  return valueOrThrow(send('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams(parameters),
  }, fetcher).andThen(response => checkedJson(response, tokenSchema, true)))
}

type Part = {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: Part[]
}
const partSchema: z.ZodType<Part> = z.lazy(() => z.object({
  mimeType: z.string().optional(), filename: z.string().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({ data: z.string().optional(), attachmentId: z.string().optional(), size: z.number().nonnegative().optional() }).optional(),
  parts: z.array(partSchema).optional(),
}))
const messageSchema = z.object({ id: z.string().min(1), threadId: z.string().optional(), snippet: z.string().optional(), labelIds: z.array(z.string()).optional(), payload: partSchema.optional() })
const pageSchema = z.object({ messages: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), threadId: z.string().optional() })).optional(), nextPageToken: z.string().optional(), resultSizeEstimate: z.number().optional() })

export class Gmail {
  private session: TokenSession<Credentials>
  constructor(store: CredentialStore<Credentials>, private fetcher: typeof fetch = fetch) {
    this.session = new TokenSession(store, credentials => send('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: 'refresh_token' }),
    }, fetcher).andThen(response => checkedJson(response, tokenSchema, true)).map(token => ({
      ...credentials, accessToken: token.access_token, refreshToken: token.refresh_token ?? credentials.refreshToken, expiresAt: Date.now() + token.expires_in * 1000,
    })))
  }

  private request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return valueOrThrow(authorizedJson(this.session, `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, schema, this.fetcher))
  }

  async list({ query, limit = 20, pageToken }: { query?: string; limit?: number; pageToken?: string }) {
    const params = new URLSearchParams({ maxResults: String(limit) })
    if (query) params.set('q', query)
    if (pageToken) params.set('pageToken', pageToken)
    const result = await this.request(`messages?${params}`, pageSchema)
    return { ...result, messages: result.messages ?? [] }
  }

  async get(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new MailFault(failure('INVALID_INPUT'))
    const message = await this.request(`messages/${encodeURIComponent(id)}?format=full`, messageSchema)
    const headers = message.payload?.headers ?? []
    const header = (name: string) => headers.find(h => h.name.toLowerCase() === name)?.value ?? ''
    const text: string[] = []
    const html: string[] = []
    const attachments: { filename: string; mimeType?: string; size?: number; attachmentId?: string }[] = []
    const visit = async (part: Part): Promise<void> => {
      const partHeader = (name: string) => part.headers?.find(h => h.name.toLowerCase() === name)?.value ?? ''
      if (part.filename || /^attachment(?:\s*;|\s*$)/i.test(partHeader('content-disposition'))) {
        attachments.push({ filename: part.filename ?? '', mimeType: part.mimeType, size: part.body?.size, attachmentId: part.body?.attachmentId })
        return
      }
      if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
        let data = part.body?.data
        if (!data && part.body?.attachmentId) {
          const body = await this.request(`messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`, z.object({ data: z.string() }))
          data = body.data
        }
        const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(partHeader('content-type'))
        const decoded = new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8').decode(Buffer.from(data ?? '', 'base64url'))
        if (part.mimeType === 'text/plain') text.push(decoded)
        if (part.mimeType === 'text/html') html.push(decoded)
      }
      for (const child of part.parts ?? []) await visit(child)
    }
    if (message.payload) await visit(message.payload)
    return {
      id: message.id, threadId: message.threadId, labelIds: message.labelIds,
      from: header('from'), to: header('to'), subject: header('subject'), date: header('date'),
      snippet: message.snippet, text: text.join('\n'), html: html.join('\n'), attachments,
    }
  }

  async search(input: Search) {
    const query = input.query ?? (input.text ? JSON.stringify(input.text) : undefined)
    const page = await this.list({ ...input, query })
    const messages = await mapLimit(page.messages, 5, async ({ id }) => {
      const message = await this.request(`messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, messageSchema)
      const header = (name: string) => message.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value ?? ''
      return { id, threadId: message.threadId, subject: header('subject'), from: header('from'), date: header('date'), snippet: message.snippet, unread: message.labelIds?.includes('UNREAD') }
    })
    return { messages, nextPageToken: page.nextPageToken }
  }
}
