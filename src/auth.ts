import { failure, MailFault } from './result.js'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { z } from 'zod'
import { exchangeToken } from './gmail.js'
import { type CredentialStore, type Credentials } from './store.js'

const clientSchema = z.object({ installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }) })

export async function login(store: CredentialStore<Credentials>, credentialsPath: string) {
  const { installed: client } = clientSchema.parse(JSON.parse(await readFile(credentialsPath, 'utf8')))
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  const listener = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') }
    catch { res.writeHead(400).end('Invalid URL'); return }
    if (req.method !== 'GET' || url.pathname !== '/callback') { res.writeHead(404).end('Not found'); return }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid state'); return }
    const code = url.searchParams.get('code')
    if (url.searchParams.has('error') || !code) {
      res.writeHead(400).end('Authorization failed. Return to the terminal.')
      rejectCode(new MailFault(failure('AUTH_REQUIRED')))
      return
    }
    res.end('Authorization received. Return to the terminal to check completion.')
    resolveCode(code)
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new MailFault(failure('NETWORK'))
  const redirectUri = `http://127.0.0.1:${address.port}/callback`
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline', prompt: 'consent', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString()
  const timer = setTimeout(() => rejectCode(new MailFault(failure('TIMEOUT'))), 300_000)
  try {
    console.error(`Open this URL in your browser:\n${url}`)
    const code = await codePromise
    const token = await exchangeToken({
      client_id: client.client_id, client_secret: client.client_secret,
      code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
    })
    if (!token.refresh_token) throw new MailFault(failure('AUTH_REQUIRED'))
    await store.save({
      clientId: client.client_id, clientSecret: client.client_secret,
      accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    })
    console.error(`Logged in. Credentials saved in ${store.directory}`)
  } finally {
    clearTimeout(timer)
    listener.closeAllConnections()
    await new Promise<void>(resolve => listener.close(() => resolve()))
  }
}
