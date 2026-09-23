#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { login } from './auth.js'
import { readFile } from 'node:fs/promises'
import { Accounts, accountId, imapCredentials } from './accounts.js'
import { Imap } from './imap.js'
import { loginOutlook } from './outlook.js'
import { MailService } from './service.js'
import { createApp } from './server.js'

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      credentials: { type: 'string' },
      account: { type: 'string' },
      provider: { type: 'string', default: 'gmail' },
      'client-id': { type: 'string' },
      tenant: { type: 'string', default: 'common' },
      port: { type: 'string', default: '3000' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(`mail-mcp login --provider gmail --account personal --credentials <google-client.json>
mail-mcp login --provider outlook --account work --client-id <app-id> [--tenant common]
mail-mcp login --provider imap --account other --credentials <imap.json>
mail-mcp accounts
mail-mcp serve [--port 3000]
mail-mcp logout --account <name>

Account names: lowercase letters, digits, hyphens, underscores (1-64 characters).
IMAP JSON: {"host":"imap.example.com","port":993,"user":"you@example.com","password":"app-password","mailbox":"INBOX"}
Credentials: ~/.mail-mcp/accounts/<name>.json
Legacy ~/.mail-mcp/tokens.json is available as account "default".
MCP endpoint: http://127.0.0.1:3000/mcp`)
    return
  }
  if (positionals.length > 1) throw new Error('Expected one command: login, serve, or logout.')
  const accounts = new Accounts()
  const id = accountId.parse(values.account ?? 'default')
  switch (positionals[0] ?? 'serve') {
    case 'login': {
      const existing = await accounts.ids()
      if (existing.includes(id) && (await accounts.read(id)).provider !== values.provider) throw new Error('This account name belongs to another provider. Choose a different --account name or log it out first.')
      if (values.provider === 'gmail') {
        if (!values.credentials) throw new Error('Gmail login requires --credentials <google-desktop-client.json>.')
        await login(accounts.credentials(id, 'gmail'), values.credentials)
      } else if (values.provider === 'outlook') {
        if (!values['client-id']) throw new Error('Outlook login requires --client-id <app-id>.')
        await loginOutlook(accounts.credentials(id, 'outlook'), values['client-id'], values.tenant)
      } else if (values.provider === 'imap') {
        if (!values.credentials) throw new Error('IMAP login requires --credentials <imap.json>.')
        const credentials = imapCredentials.parse(JSON.parse(await readFile(values.credentials, 'utf8')))
        const provider = new Imap({ directory: accounts.directory, read: async () => credentials, save: async () => {} })
        try { await provider.check() } catch { throw new Error('IMAP connection failed. Check the TLS host, port, mailbox and app password.') }
        await accounts.save(id, { provider: 'imap', credentials })
        console.error(`IMAP account "${id}" saved.`)
      } else throw new Error('Provider must be gmail, outlook, or imap.')
      break
    }
    case 'accounts':
      console.log(JSON.stringify(await new MailService(accounts).listAccounts(), null, 2))
      break
    case 'logout':
      if (!values.account && (await accounts.ids()).length > 1) throw new Error('Specify --account to log out one account.')
      await accounts.remove(values.account ?? (await accounts.ids())[0] ?? 'default')
      console.error('Local account credentials removed.')
      break
    case 'serve': {
      const port = Number(values.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.')
      if (!(await accounts.ids()).length) throw new Error('No accounts registered. Run mail-mcp login first.')
      const server = serve({ fetch: createApp(new MailService(accounts)).fetch, hostname: '127.0.0.1', port }, () => {
        console.error(`Mail MCP listening at http://127.0.0.1:${port}/mcp`)
      })
      server.on('error', () => { console.error('Could not start the server. Check whether the port is already in use.'); process.exitCode = 1 })
      const shutdown = () => {
        server.close()
        if ('closeAllConnections' in server) server.closeAllConnections()
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
      break
    }
    default: throw new Error('Unknown command. Use mail-mcp --help.')
  }
}

main().catch(error => {
  console.error(error instanceof Error && error.name !== 'ZodError' && error.name !== 'SyntaxError' ? error.message : 'Invalid account name or credentials JSON. See mail-mcp --help.')
  process.exitCode = 1
})
