#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { login } from './auth.js'
import { Gmail } from './gmail.js'
import { createApp } from './server.js'
import { TokenStore } from './store.js'

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      credentials: { type: 'string' },
      port: { type: 'string', default: '3000' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log('mail-mcp login --credentials <google-desktop-client.json>\nmail-mcp serve [--port 3000]\nmail-mcp logout\n\nCredentials: ~/.mail-mcp/tokens.json\nMCP endpoint: http://127.0.0.1:3000/mcp')
    return
  }
  if (positionals.length > 1) throw new Error('Expected one command: login, serve, or logout.')
  const store = new TokenStore()
  switch (positionals[0] ?? 'serve') {
    case 'login':
      if (!values.credentials) throw new Error('Usage: mail-mcp login --credentials <google-desktop-client.json>')
      await login(store, values.credentials)
      break
    case 'logout':
      await store.clear()
      console.error('Local credentials removed.')
      break
    case 'serve': {
      const port = Number(values.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.')
      await store.read()
      const server = serve({ fetch: createApp(new Gmail(store)).fetch, hostname: '127.0.0.1', port }, () => {
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
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Invalid Google desktop OAuth client JSON.')
  process.exitCode = 1
})
