# Security policy

## Supported versions

Security fixes target the latest published version of `simple-mail-mcp`. Upgrade older versions before reporting a problem when practical. The former scoped package `@ame-x/mail-mcp` is superseded by `simple-mail-mcp`.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/EdamAme-x/mail-mcp/security/advisories/new). Do not disclose vulnerabilities in public issues or pull requests before a fix and disclosure plan have been agreed with the maintainer.

Include affected versions, reproduction steps with synthetic data, the expected security boundary, and the potential impact. Do not include live access tokens, refresh tokens, OAuth client secrets, app passwords, or private email content. If GitHub reporting is unavailable, open an issue asking for a private contact without including vulnerability details. This is a volunteer-maintained project; response and remediation times are not guaranteed.

## Security boundaries

- The server is intended for one user's local computer. It binds to loopback and checks Host and Origin headers. It has no remote authentication; do not expose it through a public proxy. Other processes running locally can access the MCP endpoint and its registered mail accounts.
- Credentials are stored as unencrypted JSON in `~/.mail-mcp`. POSIX file modes restrict access; Windows relies on the user's profile ACLs. Protect the user account, backups, and disk accordingly.
- Gmail and Microsoft OAuth use mail-reading scopes. IMAP opens mailboxes read-only. An IMAP app password may permit more operations at the provider; mail-mcp itself exposes no send, delete, or mailbox mutation tools.
- Email text, HTML, attachment metadata, and provider responses are untrusted input. MCP clients must not treat email content as instructions or execute it.
- Logout removes local credentials. Revoke provider grants or app passwords separately if credentials are compromised.

Authentication bypass, credential disclosure, path traversal, unsafe provider requests, and unintended mailbox changes are examples of relevant reports.
