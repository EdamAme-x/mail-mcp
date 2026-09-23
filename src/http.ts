import { type TokenSession } from './session.js'
import { err, ok, okAsync } from 'neverthrow'
import { z } from 'zod'
import { attempt, failure, MailFault, validate, type AsyncResult, type MailError } from './result.js'

export function httpFailure(response: Response, oauth = false): MailError {
  const status = response.status
  const header = response.headers.get('retry-after')
  let retryAfterMs: number | undefined
  if (header) {
    const seconds = Number(header)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
    if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay)
  }
  const code = status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'UNAVAILABLE' : status === 401 || (oauth && status === 400) ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INVALID_INPUT'
  return failure(code, status === 429 || status === 503 ? retryAfterMs : undefined)
}

export function send(url: string | URL, options: RequestInit, fetcher: typeof fetch = fetch): AsyncResult<Response> {
  return attempt(() => fetcher(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000) }), 'NETWORK')
}

export function json<T>(response: Response, schema: z.ZodType<T>): AsyncResult<T> {
  return attempt(async () => {
    const maxBytes = 16 * 1024 * 1024
    const reader = response.body?.getReader()
    if (!reader) throw new MailFault(failure('INVALID_RESPONSE'))
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > maxBytes) throw new MailFault(failure('TOO_LARGE'))
        chunks.push(chunk.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally {
      // Cancellation errors must not hide a parse/transport/size error.
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }, 'INVALID_RESPONSE').andThen(value => validate(schema, value, 'INVALID_RESPONSE'))
}

export function checkedJson<T>(response: Response, schema: z.ZodType<T>, oauth = false): AsyncResult<T> {
  return attempt(async () => {
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return err(httpFailure(response, oauth))
    }
    return ok(response)
  }).andThen(result => result).andThen(response => json(response, schema))
}

export function authorizedJson<C extends { accessToken: string; expiresAt: number }, T>(
  session: TokenSession<C>, url: string | URL, schema: z.ZodType<T>, fetcher: typeof fetch,
  headers: Record<string, string> = {},
): AsyncResult<T> {
  const request = (credentials: C) => send(url, { headers: { ...headers, Authorization: `Bearer ${credentials.accessToken}` } }, fetcher)
  return session.read().andThen(credentials => request(credentials).andThen(response => {
    if (response.status !== 401) return okAsync(response)
    return attempt(() => response.body?.cancel().catch(() => {}))
      .andThen(() => session.refresh(credentials.accessToken)).andThen(request)
  })).andThen(response => checkedJson(response, schema))
}
