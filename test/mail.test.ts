import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { TokenStore } from '../src/store.js'
import { Gmail } from '../src/gmail.js'
import { createApp } from '../src/server.js'
import { login } from '../src/auth.js'
import { type MailService } from '../src/service.js'

const credentials = { clientId: 'test-client', clientSecret: 'test-secret', accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600_000 }

async function temporaryStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-mcp-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return new TokenStore(directory)
}

test('credentials round-trip, replace atomically, and logout', async t => {
  const store = await temporaryStore(t)
  await assert.rejects(store.read(), /No valid credentials/)
  await store.save(credentials)
  assert.deepEqual(await store.read(), credentials)
  await store.save({ ...credentials, accessToken: 'new-access' })
  assert.equal((await store.read()).accessToken, 'new-access')
  assert.deepEqual(await readdir(store.directory), ['tokens.json'])
  if (process.platform !== 'win32') {
    assert.equal((await stat(store.directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(store.directory, 'tokens.json'))).mode & 0o777, 0o600)
  }
  await store.clear()
  await assert.rejects(store.read(), /No valid credentials/)
})

test('expired tokens refresh once for concurrent requests and preserve the refresh token', async t => {
  const store = await temporaryStore(t)
  await store.save({ ...credentials, expiresAt: 0 })
  let refreshes = 0
  const gmail = new Gmail(store, async (input, options) => {
    const url = new URL(String(input))
    if (url.hostname === 'oauth2.googleapis.com') {
      refreshes++
      assert.equal((options?.body as URLSearchParams).get('refresh_token'), 'test-refresh')
      await new Promise(resolve => setTimeout(resolve, 20))
      return Response.json({ access_token: 'new-access', expires_in: 3600 })
    }
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer new-access')
    assert.equal(url.searchParams.get('q'), 'is:unread')
    assert.equal(url.searchParams.get('pageToken'), 'page+2')
    return Response.json({ nextPageToken: 'page3' })
  })
  const results = await Promise.all([1, 2, 3].map(() => gmail.list({ query: 'is:unread', pageToken: 'page+2' })))
  assert.equal(refreshes, 1)
  assert.deepEqual(results[0], { messages: [], nextPageToken: 'page3' })
  assert.equal((await store.read()).refreshToken, 'test-refresh')
})

test('401 refreshes once and retries; provider errors do not expose response bodies', async t => {
  const store = await temporaryStore(t)
  await store.save(credentials)
  let requests = 0
  const gmail = new Gmail(store, async input => {
    if (String(input).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'new-access', expires_in: 3600 })
    requests++
    return new Response('secret provider body', { status: 401 })
  })
  await assert.rejects(gmail.list({}), { message: 'Gmail request failed (401).' })
  assert.equal(requests, 2)
})

test('message decoding handles nested MIME parts and attachment metadata', async t => {
  const store = await temporaryStore(t)
  await store.save(credentials)
  const gmail = new Gmail(store, async () => Response.json({
    id: '123', threadId: '456', payload: {
      headers: [{ name: 'Subject', value: 'Test mail' }], parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('こんにちは').toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from('<p>Hello</p>').toString('base64url') } },
        ] },
        { filename: 'note.txt', mimeType: 'text/plain', body: { data: Buffer.from('attachment').toString('base64url'), size: 10 } },
      ],
    },
  }))
  const message = await gmail.get('123')
  assert.equal(message.subject, 'Test mail')
  assert.equal(message.text, 'こんにちは')
  assert.equal(message.html, '<p>Hello</p>')
  assert.equal(message.attachments[0]?.filename, 'note.txt')
})

test('real MCP HTTP client initializes, lists and calls tools, and validates arguments', async t => {
  const app = createApp({ listAccounts: async () => [{ account: 'personal', provider: 'gmail' }], list: async () => ({ messages: [{ id: '123', threadId: '456' }] }), get: async ({ id }) => ({ id, text: 'Hello' }), getMany: async () => [] } as unknown as MailService)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = new Client({ name: 'test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_accounts', 'list_messages', 'get_message', 'get_messages'])
  const messages = await client.callTool({ name: 'list_messages', arguments: { query: 'is:unread' } })
  assert.match(JSON.stringify(messages), /123/)
  const message = await client.callTool({ name: 'get_message', arguments: { id: '123' } })
  assert.match(JSON.stringify(message), /Hello/)
  const invalid = await client.callTool({ name: 'list_messages', arguments: { limit: 101 } })
  assert.equal(invalid.isError, true)
})

test('message body stored separately is fetched, but file attachments are not', async t => {
  const store = await temporaryStore(t)
  await store.save(credentials)
  const paths: string[] = []
  const gmail = new Gmail(store, async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path.endsWith('/attachments/body-id')) {
      return Response.json({ data: Buffer.from('Full message body').toString('base64url') })
    }
    return Response.json({ id: '123', threadId: '456', payload: { parts: [
      { mimeType: 'text/plain', body: { data: '', attachmentId: 'body-id' } },
      { mimeType: 'text/plain', filename: 'file.txt', body: { attachmentId: 'file-id' } },
      { mimeType: 'text/plain', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'unnamed-file-id' } },
    ] } })
  })
  const message = await gmail.get('123')
  assert.equal(message.text, 'Full message body')
  assert.equal(message.attachments.length, 2)
  assert.deepEqual(paths, ['/gmail/v1/users/me/messages/123', '/gmail/v1/users/me/messages/123/attachments/body-id'])
})

test('message body uses the MIME charset instead of assuming UTF-8', async t => {
  const store = await temporaryStore(t)
  await store.save(credentials)
  const gmail = new Gmail(store, async () => Response.json({ id: '123', threadId: '456', payload: {
    mimeType: 'text/plain',
    headers: [{ name: 'Content-Type', value: 'text/plain; charset="Shift_JIS"' }],
    body: { data: Buffer.from([0x82, 0xa0]).toString('base64url') },
  } }))
  assert.equal((await gmail.get('123')).text, 'あ')
})

test('HTTP rejects foreign hosts and browser origins', async () => {
  const app = createApp({} as MailService)
  assert.equal((await app.request('http://evil.example/mcp', { method: 'POST' })).status, 403)
  assert.equal((await app.request('http://localhost:3000/mcp', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403)
})

test('login validates state, uses PKCE and saves exchanged tokens', async t => {
  const store = await temporaryStore(t)
  const path = join(store.directory, 'client.json')
  await writeFile(path, JSON.stringify({ installed: { client_id: 'client', client_secret: 'secret' } }))
  let authUrl!: URL
  let receivedUrl!: (url: URL) => void
  const urlReady = new Promise<URL>(resolve => { receivedUrl = resolve })
  t.mock.method(console, 'error', (message: string) => {
    if (message.startsWith('Open this URL')) receivedUrl(new URL(message.split('\n')[1]!))
  })
  const realFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    if (String(input) !== 'https://oauth2.googleapis.com/token') return realFetch(input, options)
    const params = options?.body as URLSearchParams
    assert.equal(params.get('code'), 'test-code')
    assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), authUrl.searchParams.get('code_challenge'))
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
  })
  const pending = login(store, path)
  authUrl = await urlReady
  const callback = new URL(authUrl.searchParams.get('redirect_uri')!)
  const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest({ hostname: callback.hostname, port: callback.port, path: '//[' }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(malformedStatus, 400)
  callback.search = new URLSearchParams({ state: 'wrong', code: 'test-code' }).toString()
  assert.equal((await realFetch(callback)).status, 400)
  callback.searchParams.set('state', authUrl.searchParams.get('state')!)
  assert.equal((await realFetch(callback)).status, 200)
  await pending
  assert.equal((await store.read()).refreshToken, 'refresh')
  assert(! (await readFile(join(store.directory, 'tokens.json'), 'utf8')).includes('code_verifier'))
})
