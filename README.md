# mail-mcp

Read and search mail across multiple Gmail, Outlook / Microsoft 365, and IMAP accounts through one local MCP server. Built with TypeScript, Hono and `@hono/mcp`. Requires Node.js 22 or newer.

## Install

```sh
npm install -g mail-mcp
```

Upgrading from the former scoped package:

```sh
npm uninstall -g @ame-x/mail-mcp
npm install -g mail-mcp
```

The command and `~/.mail-mcp` account storage stay the same; existing accounts do not need to be registered again.

Each login gets a local account name, such as `personal`, `work`, or `icloud`. You can register multiple accounts from the same provider. Names use lowercase letters, digits, hyphens and underscores (1–64 characters).

## Register accounts

### Gmail

Enable the Gmail API in a Google Cloud project, configure the OAuth consent screen, and create a **Desktop app** OAuth client. Download its JSON file. If the app is in testing, add your Google account as a test user.

```sh
mail-mcp login --provider gmail --account personal --credentials ./google-client.json
mail-mcp login --provider gmail --account second --credentials ./google-client.json
```

Open the printed URL and sign in to the intended Google account. Login uses PKCE and `gmail.readonly`; access tokens refresh automatically. Google can expire refresh tokens after seven days for external OAuth apps in testing.

### Outlook / Microsoft 365

Register an application in Microsoft Entra. Select supported account types that include the accounts you want to use (including personal Microsoft accounts for Outlook.com). Enable **Allow public client flows** in Authentication and add the Microsoft Graph **delegated** `Mail.Read` permission. Your organization may require administrator consent or prohibit device code login.

```sh
mail-mcp login --provider outlook --account work --client-id YOUR_APPLICATION_ID
mail-mcp login --provider outlook --account private --client-id YOUR_APPLICATION_ID --tenant consumers
```

Open the displayed Microsoft URL and enter the code. The default tenant is `common`; you can also specify `organizations`, `consumers`, or a tenant ID. Requests use `Mail.Read` and `offline_access`. Refresh tokens are updated locally. This release uses the global Microsoft cloud endpoints.

### IMAP

Use your provider's TLS IMAP endpoint and an app password when required. This covers providers that permit password/app-password IMAP access, including many hosted and custom-domain mail services. It does not bypass a provider's login restrictions. Providers that require OAuth should use a supported OAuth adapter.

Prepare a local JSON file (keep it outside your repository):

```json
{
  "host": "imap.example.com",
  "port": 993,
  "user": "you@example.com",
  "password": "YOUR_APP_PASSWORD",
  "mailbox": "INBOX"
}
```

```sh
mail-mcp login --provider imap --account other --credentials ./imap-account.json
```

Login verifies the TLS connection and opens the mailbox read-only before saving. Port defaults to 993; mailbox defaults to `INBOX`. IMAP searches cover the configured mailbox, while Gmail and Outlook search their accounts. To read another IMAP mailbox, register it under another account name. Implicit TLS with certificate verification is required; STARTTLS and plaintext connections are not supported. The source JSON is not deleted automatically and still contains a password.

## Start and connect

```sh
mail-mcp accounts
mail-mcp serve
```

Connect your MCP client to `http://127.0.0.1:3000/mcp` using Streamable HTTP. For clients using a `mcpServers` URL configuration:

```json
{
  "mcpServers": {
    "mail": { "url": "http://127.0.0.1:3000/mcp" }
  }
}
```

Keep `serve` running separately. Choose another port with `--port 3001`. The transport is HTTP, not stdio.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_accounts` | List local account names and providers; never returns credentials |
| `list_messages` | List/search all or selected accounts; return summaries with source account, provider and message ID |
| `get_message` | Read one message using its account and ID |
| `get_messages` | Read up to 20 messages across accounts, retaining successful results when another read fails |

Cross-account keyword search:

```json
{ "text": "invoice", "limit": 10 }
```

Restrict the search to two accounts:

```json
{ "accounts": ["personal", "work"], "text": "invoice", "limit": 10 }
```

`text` is passed to each provider's text-search facility. Tokenization, indexed fields and matching differ: Gmail searches its mail index, Outlook searches its message index, and IMAP uses `TEXT`. This is not a shared exact-match search engine. Use Gmail's native operators for a single Gmail account:

```json
{ "accounts": ["personal"], "query": "is:unread from:billing@example.com" }
```

`query` cannot be combined with `text` and requires exactly one Gmail account. For a single registered Gmail account, old `query` calls still work.

`limit` is **per account**, from 1 to 100 (default 20). Results are combined and sorted by date within each returned page; this is not a globally paginated timeline. IMAP selects messages in descending UID order. Outlook keyword search is limited by Microsoft's search-result cap (up to 1,000 messages).

The result contains `messages`, `nextPageTokens`, and per-account `errors`. To continue, pass `nextPageTokens` back as `pageTokens`, with the same search inputs:

```json
{
  "text": "invoice",
  "limit": 10,
  "pageTokens": { "personal": "TOKEN_FROM_RESULT" }
}
```

Only accounts present in `pageTokens` are queried on continuation, so completed accounts are not restarted. An empty map ends the search. If `accounts` is also specified, every selected account must have a token. A single-account call can also pass `pageToken`. Tokens are provider-specific and must not be edited.

Read the returned message reference:

```json
{ "account": "work", "id": "ID_FROM_LIST" }
```

Batch read:

```json
{
  "messages": [
    { "account": "personal", "id": "ID_1" },
    { "account": "work", "id": "ID_2" }
  ]
}
```

IDs belong to their source account. `account` may be omitted for `get_message` only when exactly one account is registered. IMAP IDs include UIDVALIDITY to reject stale references after a mailbox reset. The message is returned under `message`, alongside its account and provider. Text, HTML, dates and attachment metadata depend on what the provider supplies. Treat email content as untrusted input.

No tool sends, deletes, moves, or marks messages as read. File attachment contents are not returned. For IMAP, reading parses the complete raw message, including attachments, with a 10 MiB download limit; larger messages return an error. Gmail separately stored text bodies are fetched automatically.

## Errors (v0.3)

Tool failures set MCP `isError: true` and return JSON under `error`:

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication expired or was rejected. Log in to this account again.",
    "retryable": false
  }
}
```

Errors have stable `code`, safe `message`, and `retryable` fields. Rate limits and temporary HTTP failures may include `retryAfterMs` from `Retry-After`. No automatic retries run except a single OAuth refresh/retry after a 401.

| Code | Action |
| --- | --- |
| `INVALID_INPUT` | Check arguments, account selection, and page tokens. |
| `ACCOUNT_NOT_FOUND`, `CREDENTIALS_INVALID`, `AUTH_REQUIRED` | Register or log in to the affected account again. |
| `PROVIDER_CHANGED` | Restart the server after changing an account's provider. |
| `STORAGE` | Check credential file access and available disk space. |
| `FORBIDDEN` | Check the provider's granted mail permissions. |
| `NOT_FOUND`, `STALE_CURSOR` | Search again to obtain current message IDs. |
| `RATE_LIMITED`, `UNAVAILABLE`, `TIMEOUT`, `NETWORK` | Retry later, respecting `retryAfterMs` when present. |
| `INVALID_RESPONSE`, `TOO_LARGE`, `INTERNAL` | The response could not be processed; retrying unchanged input may not help. |
| `ALL_FAILED` | Inspect `failures` for each account/message's error and retry advice. |

Cross-account searches and batch reads preserve partial results. Their per-item `error` fields now contain these objects instead of v0.2 strings. If every item fails, the tool returns `ALL_FAILED` with a `failures` array containing `account`, optional `id`, and `error`. An empty successful search remains a success, including when other selected accounts fail. This behavior also applies to `list_accounts`.

Provider JSON is validated before use and limited to 16 MiB per response. Outlook attachment pagination rejects loops and stops after 100 pages. OAuth refreshes are shared within each account's client; a late 401 reuses the refreshed token. If saving a rotated token fails, the client retains it in memory and retries saving on the next request. Restarting before that save succeeds loses the in-memory token and may require logging in again.

## Stored credentials and upgrading

Credentials are stored as local JSON in `~/.mail-mcp/accounts/<name>.json`. Each account has its own file, so refreshing one does not overwrite another. Files are written atomically, with directory/file modes `0700` / `0600` on POSIX; Windows uses your user profile's ACLs. Credentials are not encrypted.

The old `~/.mail-mcp/tokens.json` from v0.1 is recognized as Gmail account `default`. It moves to `accounts/default.json` on the next successful token save. Existing credentials need no manual editing. Login without `--account` still targets `default`.

```sh
mail-mcp logout --account work
```

Logout removes only that account's local credentials, not the provider's grant. Stop the server before changing accounts or running another instance against the same credential directory. Revoke grants in the provider's settings when needed. Malformed credentials are reported per account without exposing their contents.

The server binds to `127.0.0.1` and rejects foreign Host and Origin headers. It has no remote authentication; do not expose it through a public proxy. Local processes can access the endpoint.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and pull requests, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [CHANGELOG.md](CHANGELOG.md) for release notes.

Linting and formatting use [Ultracite](https://www.ultracite.ai/) with Oxlint and Oxfmt. `npm run check` runs lint, formatting, and TypeScript checks. Use `npm run fix` to apply lint fixes and formatting, and review the resulting diff. Development tooling requires Node.js 22.12 or newer.

Keep documentation, code comments, CLI output, and setup pages in English. Encoding tests should use Unicode escapes for non-English text fixtures.

`MailService` returns `neverthrow` `ResultAsync<T, MailError>`. Use `andThen` for dependent operations, `map` for successful values, `orElse` for recovery, and `match` at the MCP boundary. Expected failures are values; they do not depend on matching exception messages. Promise-based storage, HTTP, and IMAP adapters are converted at I/O boundaries with `attempt`. `guard` also captures unexpected exceptions in composition callbacks. `valueOrThrow` is reserved for imperative protocol adapters and the CLI, outside domain composition.

```sh
npm ci
npm run check
npm test
npm run build
node dist/cli.js --help
npm pack --dry-run
npm publish --access public
```

Tests use fake credentials and mocked provider responses; they do not log in to real mailboxes. CI runs on Node 22/24 on Windows/Linux. `prepack` builds the CLI; only compiled JavaScript, package metadata, README and license are published.

References: [Hono MCP](https://github.com/honojs/middleware/tree/main/packages/mcp), [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Microsoft device login](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code), [Graph messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages), [ImapFlow](https://imapflow.com/docs/api/imapflow-client/).
