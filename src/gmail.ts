import { z } from 'zod'
import { TokenStore, type Credentials } from './store.js'

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
})

export async function exchangeToken(parameters: Record<string, string>, fetcher: typeof fetch = fetch) {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Google authentication failed (${response.status}). Run mail-mcp login again.`)
  return tokenSchema.parse(await response.json())
}

type Part = {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: Part[]
}
type Message = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: Part }

export class Gmail {
  private refreshing?: Promise<Credentials>
  constructor(private store: TokenStore, private fetcher: typeof fetch = fetch) {}

  private async refresh(credentials: Credentials): Promise<Credentials> {
    this.refreshing ??= (async () => {
      const token = await exchangeToken({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      }, this.fetcher)
      const updated = {
        ...credentials,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        expiresAt: Date.now() + token.expires_in * 1000,
      }
      await this.store.save(updated)
      return updated
    })()
    try { return await this.refreshing } finally { this.refreshing = undefined }
  }

  private async request<T>(path: string): Promise<T> {
    let credentials = await this.store.read()
    if (credentials.expiresAt <= Date.now() + 60_000) credentials = await this.refresh(credentials)
    const send = () => this.fetcher(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    })
    let response = await send()
    if (response.status === 401) {
      credentials = await this.refresh(credentials)
      response = await send()
    }
    if (!response.ok) throw new Error(`Gmail request failed (${response.status}).`)
    return await response.json() as T
  }

  async list({ query, limit = 20, pageToken }: { query?: string; limit?: number; pageToken?: string }) {
    const params = new URLSearchParams({ maxResults: String(limit) })
    if (query) params.set('q', query)
    if (pageToken) params.set('pageToken', pageToken)
    const result = await this.request<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(`messages?${params}`)
    return { ...result, messages: result.messages ?? [] }
  }

  async get(id: string) {
    const message = await this.request<Message>(`messages/${encodeURIComponent(id)}?format=full`)
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
          const body = await this.request<{ data: string }>(`messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)
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
}
