import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { outlookCredentials, type OutlookCredentials } from './accounts.js'
import { type CredentialStore } from './store.js'
import { type MailProvider, type Search } from './mail.js'

const scope = 'https://graph.microsoft.com/Mail.Read offline_access'
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive() })
const endpoint = (tenant: string) => {
  outlookCredentials.shape.tenant.parse(tenant)
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`
}
async function post(url: string, body: Record<string, string>, fetcher: typeof fetch) {
  return fetcher(url, { method: 'POST', body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000), redirect: 'error' })
}

export async function loginOutlook(store: CredentialStore<OutlookCredentials>, clientId: string, tenant = 'common', fetcher: typeof fetch = fetch, sleep: (ms: number) => Promise<unknown> = delay) {
  const base = endpoint(tenant)
  const response = await post(`${base}/devicecode`, { client_id: clientId, scope }, fetcher)
  if (!response.ok) throw new Error(`Microsoft login could not start (${response.status}). Check the app registration.`)
  const device = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string().url(), expires_in: z.number().positive(), interval: z.number().positive().default(5) }).parse(await response.json())
  console.error(`Open ${device.verification_uri} and enter code: ${device.user_code}`)
  const deadline = Date.now() + device.expires_in * 1000
  let interval = device.interval * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    if (Date.now() >= deadline) break
    const response = await post(`${base}/token`, { client_id: clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, fetcher)
    const data = await response.json()
    if (response.ok) {
      const token = tokenSchema.parse(data)
      if (!token.refresh_token) throw new Error('Microsoft returned no refresh token. Sign in again with offline_access.')
      await store.save({ clientId, tenant, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 })
      console.error('Outlook account saved.')
      return
    }
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') { interval += 5000; continue }
    throw new Error('Microsoft login was denied or expired. Run login again.')
  }
  throw new Error('Microsoft login timed out. Run login again.')
}

type GraphMessage = {
  id: string; conversationId?: string; subject?: string; receivedDateTime?: string; bodyPreview?: string; isRead?: boolean
  from?: { emailAddress: { name?: string; address?: string } }
  toRecipients?: { emailAddress: { address?: string } }[]
  body?: { contentType: string; content: string }; hasAttachments?: boolean
}
type GraphPage<T> = { value: T[]; '@odata.nextLink'?: string }

export class Outlook implements MailProvider {
  private refreshing?: Promise<OutlookCredentials>
  constructor(private store: CredentialStore<OutlookCredentials>, private fetcher: typeof fetch = fetch) {}

  private async refresh(credentials: OutlookCredentials) {
    this.refreshing ??= (async () => {
      const response = await post(`${endpoint(credentials.tenant)}/token`, { client_id: credentials.clientId, refresh_token: credentials.refreshToken, grant_type: 'refresh_token', scope }, this.fetcher)
      if (!response.ok) throw new Error('Microsoft token refresh failed. Log in again.')
      const token = tokenSchema.parse(await response.json())
      const updated = { ...credentials, accessToken: token.access_token, refreshToken: token.refresh_token ?? credentials.refreshToken, expiresAt: Date.now() + token.expires_in * 1000 }
      await this.store.save(updated)
      return updated
    })()
    try { return await this.refreshing } finally { this.refreshing = undefined }
  }

  private async request<T>(path: string): Promise<T> {
    const url = new URL(path, 'https://graph.microsoft.com/v1.0/me/')
    if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash || !/^\/v1\.0\/me\/messages(?:\/|$)/.test(url.pathname)) throw new Error('Invalid Outlook page token.')
    let credentials = await this.store.read()
    if (credentials.expiresAt < Date.now() + 60_000) credentials = await this.refresh(credentials)
    const send = () => this.fetcher(url, { headers: { Authorization: `Bearer ${credentials.accessToken}`, Prefer: 'IdType="ImmutableId"' }, signal: AbortSignal.timeout(30_000), redirect: 'error' })
    let response = await send()
    if (response.status === 401) { credentials = await this.refresh(credentials); response = await send() }
    if (!response.ok) throw new Error(`Outlook request failed (${response.status}).`)
    return await response.json() as T
  }

  async list({ text, limit = 20, pageToken }: Search) {
    const params = new URLSearchParams({ '$top': String(limit), '$select': 'id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead' })
    if (text) params.set('$search', JSON.stringify(text))
    else params.set('$orderby', 'receivedDateTime desc')
    if (pageToken && new URL(pageToken).pathname !== '/v1.0/me/messages') throw new Error('Invalid Outlook page token.')
    const page = await this.request<GraphPage<GraphMessage>>(pageToken ?? `messages?${params}`)
    return {
      messages: page.value.map(m => ({ id: m.id, threadId: m.conversationId, subject: m.subject, from: m.from?.emailAddress.address, date: m.receivedDateTime, snippet: m.bodyPreview, unread: m.isRead === false })),
      nextPageToken: page['@odata.nextLink'],
    }
  }

  async get(id: string) {
    const path = `messages/${encodeURIComponent(id)}`
    const m = await this.request<GraphMessage>(`${path}?$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,isRead`)
    const attachments: { id: string; name: string; contentType: string; size: number; isInline: boolean }[] = []
    if (m.hasAttachments) {
      let next: string | undefined = `${path}/attachments?$select=id,name,contentType,size,isInline`
      while (next) {
        const page: GraphPage<(typeof attachments)[number]> = await this.request(next)
        attachments.push(...page.value)
        next = page['@odata.nextLink']
      }
    }
    return { id: m.id, threadId: m.conversationId, subject: m.subject, from: m.from?.emailAddress.address, to: m.toRecipients?.map(r => r.emailAddress.address).join(', '), date: m.receivedDateTime, unread: m.isRead === false, snippet: m.bodyPreview, text: m.body?.contentType.toLowerCase() === 'text' ? m.body.content : '', html: m.body?.contentType.toLowerCase() === 'html' ? m.body.content : '', attachments: attachments.map(a => ({ filename: a.name, mimeType: a.contentType, size: a.size, attachmentId: a.id })) }
  }
}
