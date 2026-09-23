# mail-mcp

A small Gmail MCP server built with TypeScript, Hono, and `@hono/mcp`.
Log in once, keep credentials in `~/.mail-mcp/tokens.json`, and read mail through MCP.

Requires Node.js 22 or newer. Supports one Gmail account, read-only.

## Set up

1. Enable the Gmail API in your Google Cloud project, configure the OAuth consent screen, and add your Google account as a test user if the app is in testing.
2. Create an OAuth client of type **Desktop app** and download its JSON file.
3. Install and log in:

```sh
npm install -g @ame-x/mail-mcp
mail-mcp login --credentials /path/to/google-desktop-client.json
mail-mcp serve
```

Open the URL printed by `login` in your browser. Google redirects to a temporary
loopback listener. The terminal confirms when credentials have been saved.
Login uses PKCE and `gmail.readonly`. Access tokens refresh automatically.
While an external OAuth app is in testing, Google may expire its refresh tokens
after seven days; log in again if needed.

To run from a local checkout:

```sh
npm ci
npm run build
node dist/cli.js login --credentials /path/to/google-desktop-client.json
node dist/cli.js serve
```

## Connect an MCP client

Use the Streamable HTTP URL `http://127.0.0.1:3000/mcp` in your client's MCP settings.
For clients with a `mcpServers` URL configuration:

```json
{
  "mcpServers": {
    "mail": { "url": "http://127.0.0.1:3000/mcp" }
  }
}
```

Start `mail-mcp serve` separately and keep it running. Transport is HTTP, not stdio.
Choose another port with `mail-mcp serve --port 3001`.

| Tool | Parameters | Result |
| --- | --- | --- |
| `list_messages` | `query?`, `limit?` (1–100, default 20), `pageToken?` | Message IDs, thread IDs, next page token |
| `get_message` | `id` | Headers, plain text, HTML, attachment metadata |

`query` accepts Gmail search syntax, e.g. `is:unread` or `from:someone@example.com`.
Pass `nextPageToken` as `pageToken` to fetch the next page. Read message IDs with
`get_message`. Text bodies stored separately by Gmail are fetched automatically
and decoded using their MIME charset. File attachment contents are not downloaded.

## Credentials

`~/.mail-mcp/tokens.json` contains the OAuth client credentials, access token,
refresh token, and expiry time as local JSON. MCP tools never return credentials.
Directory/file permissions are `0700` / `0600` on POSIX. Windows uses your user
profile's ACLs. The file is not encrypted.

`mail-mcp logout` removes local credentials; it does not revoke Google's grant.
Revoke that separately in your Google account settings if needed. Stop the server
before login/logout or starting another instance against the same credential file.

The server binds to `127.0.0.1` and rejects foreign Host and Origin headers.
It has no remote authentication: use locally and do not expose through a proxy.
Local processes can use the endpoint. Treat email content as untrusted input.

## Development and release

```sh
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
# Requires an npm account with permission to publish this package name:
npm publish --access public
```

`prepack` builds the CLI. The archive contains compiled JavaScript, package
metadata, this README, and the license.

References: [Hono MCP](https://github.com/honojs/middleware/tree/main/packages/mcp),
[Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Gmail API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).
