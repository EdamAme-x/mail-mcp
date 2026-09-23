import { z } from 'zod'
import { authorizedJson, checkedJson, json, send } from './http.js'
import { TokenSession } from './session.js'
import { failure, MailFault, validate, valueOrThrow } from './result.js'
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
  return valueOrThrow(send(url, { method: 'POST', body: new URLSearchParams(body) }, fetcher))
}

export async function loginOutlook(store: CredentialStore<OutlookCredentials>, clientId: string, tenant = 'common', fetcher: typeof fetch = fetch, sleep: (ms: number) => Promise<unknown> = delay) {
  const base = endpoint(tenant)
  const response = await post(`${base}/devicecode`, { client_id: clientId, scope }, fetcher)
  const device = await valueOrThrow(checkedJson(response, z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.url({ protocol: /^https$/ }), expires_in: z.number().positive(), interval: z.number().positive().default(5) }), true))
  console.error(`Open ${device.verification_uri} and enter code: ${device.user_code}`)
  const deadline = Date.now() + device.expires_in * 1000
  let interval = device.interval * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    if (Date.now() >= deadline) break
    const response = await post(`${base}/token`, { client_id: clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, fetcher)
    const data = await valueOrThrow(json(response, z.unknown()))
    if (response.ok) {
      const parsed = validate(tokenSchema, data, 'INVALID_RESPONSE')
      if (parsed.isErr()) throw new MailFault(parsed.error)
      const token = parsed.value
      if (!token.refresh_token) throw new MailFault(failure('AUTH_REQUIRED'))
      await store.save({ clientId, tenant, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 })
      console.error('Outlook account saved.')
      return
    }
    const problem = validate(z.object({ error: z.string() }), data, 'INVALID_RESPONSE')
    if (problem.isErr()) throw new MailFault(problem.error)
    if (problem.value.error === 'authorization_pending') continue
    if (problem.value.error === 'slow_down') { interval += 5000; continue }
    throw new MailFault(failure('AUTH_REQUIRED'))
  }
  throw new MailFault(failure('TIMEOUT'))
}

// Graph can omit or return null for unset message properties (for example drafts).
const optional = <T>(schema: z.ZodType<T>) => schema.nullish().transform(value => value ?? undefined)
const addressSchema = z.object({ emailAddress: optional(z.object({ name: optional(z.string()), address: optional(z.string()) })) })
const messageSchema = z.object({
  id: z.string().min(1), conversationId: optional(z.string()), subject: optional(z.string()), receivedDateTime: optional(z.string()), bodyPreview: optional(z.string()), isRead: optional(z.boolean()),
  from: optional(addressSchema), toRecipients: optional(z.array(addressSchema)),
  body: optional(z.object({ contentType: z.string(), content: z.string() })), hasAttachments: optional(z.boolean()),
})
const attachmentSchema = z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number().nonnegative(), isInline: z.boolean() })
const pageSchema = <T>(item: z.ZodType<T>) => z.object({ value: z.array(item), '@odata.nextLink': z.string().optional() })

export class Outlook implements MailProvider {
  private session: TokenSession<OutlookCredentials>
  constructor(store: CredentialStore<OutlookCredentials>, private fetcher: typeof fetch = fetch) {
    this.session = new TokenSession(store, credentials => send(`${endpoint(credentials.tenant)}/token`, {
      method: 'POST', body: new URLSearchParams({ client_id: credentials.clientId, refresh_token: credentials.refreshToken, grant_type: 'refresh_token', scope }),
    }, fetcher).andThen(response => checkedJson(response, tokenSchema, true)).map(token => ({
      ...credentials, accessToken: token.access_token, refreshToken: token.refresh_token ?? credentials.refreshToken, expiresAt: Date.now() + token.expires_in * 1000,
    })))
  }

  private async request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let url: URL
    try { url = new URL(path, 'https://graph.microsoft.com/v1.0/me/') }
    catch { throw new MailFault(failure('INVALID_INPUT')) }
    if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash || !/^\/v1\.0\/me\/messages(?:\/|$)/.test(url.pathname)) throw new MailFault(failure('INVALID_INPUT'))
    return valueOrThrow(authorizedJson(this.session, url, schema, this.fetcher, { Prefer: 'IdType="ImmutableId"' }))
  }

  async list({ text, limit = 20, pageToken }: Search) {
    const params = new URLSearchParams({ '$top': String(limit), '$select': 'id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead' })
    if (text) params.set('$search', JSON.stringify(text))
    else params.set('$orderby', 'receivedDateTime desc')
    if (pageToken) {
      let url: URL
      try { url = new URL(pageToken) } catch { throw new MailFault(failure('INVALID_INPUT')) }
      if (url.pathname !== '/v1.0/me/messages') throw new MailFault(failure('INVALID_INPUT'))
    }
    const page = await this.request(pageToken ?? `messages?${params}`, pageSchema(messageSchema))
    return {
      messages: page.value.map(m => ({ id: m.id, threadId: m.conversationId, subject: m.subject, from: m.from?.emailAddress?.address, date: m.receivedDateTime, snippet: m.bodyPreview, unread: m.isRead === false })),
      nextPageToken: page['@odata.nextLink'],
    }
  }

  async get(id: string) {
    const path = `messages/${encodeURIComponent(id)}`
    const m = await this.request(`${path}?$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,isRead`, messageSchema)
    const attachments: { id: string; name: string; contentType: string; size: number; isInline: boolean }[] = []
    if (m.hasAttachments) {
      let next: string | undefined = `${path}/attachments?$select=id,name,contentType,size,isInline`
      const visited = new Set<string>()
      while (next) {
        if (visited.has(next) || visited.size >= 100) throw new MailFault(failure('INVALID_RESPONSE'))
        visited.add(next)
        const page: { value: z.infer<typeof attachmentSchema>[]; '@odata.nextLink'?: string } = await this.request(next, pageSchema(attachmentSchema))
        attachments.push(...page.value)
        next = page['@odata.nextLink']
      }
    }
    return { id: m.id, threadId: m.conversationId, subject: m.subject, from: m.from?.emailAddress?.address, to: m.toRecipients?.map(r => r.emailAddress?.address).join(', '), date: m.receivedDateTime, unread: m.isRead === false, snippet: m.bodyPreview, text: m.body?.contentType.toLowerCase() === 'text' ? m.body.content : '', html: m.body?.contentType.toLowerCase() === 'html' ? m.body.content : '', attachments: attachments.map(a => ({ filename: a.name, mimeType: a.contentType, size: a.size, attachmentId: a.id })) }
  }
}
