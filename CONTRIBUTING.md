# Contributing to mail-mcp

Bug reports, focused improvements, tests, and documentation fixes are welcome. Search existing issues before opening a new one. For larger changes, describe the problem and proposed approach in an issue first.

## Local development

Use a current Node.js 22 or 24 release and npm. Development tooling requires Node.js 22.12 or newer. Fork the repository, create a branch, then run:

```sh
npm ci
npm run check
npm test
npm run build
node dist/cli.js --help
```

`npm run check` runs Ultracite (Oxlint and Oxfmt) and TypeScript. Use `npm run fix` for lint fixes and formatting, or `npm run format` for formatting only. Review automatic fixes before committing. Configuration exceptions in `oxlint.config.ts` document the Node I/O and ResultAsync patterns used in this project.

## Changes and tests

- Keep documentation, comments, CLI messages, and user-facing pages in English.
- Keep changes focused; describe the problem and resulting behavior in the PR.
- Preserve the read-only mail interface and loopback-only HTTP server.
- Compose domain failures with `neverthrow` `ResultAsync`. Convert throws and rejected promises at I/O boundaries with `attempt`; use `match` at the MCP boundary. Do not expose provider response bodies or credential values in errors.
- Add regression tests for behavior changes. Tests must use fake credentials, temporary directories, and mocked providers; they must not require real accounts.
- Use Unicode escapes for non-English encoding fixtures.
- Commit `package-lock.json` when dependencies change. Do not commit generated `dist/` files, archives, credentials, or local account data.

Before opening a pull request, run `npm run check`, `npm test`, and `npm pack --dry-run`. CI checks Windows and Linux on Node.js 22 and 24. Explain any validation you could not run. Maintainers review and merge changes.

## Reporting issues

Include the package version, Node.js version, operating system, provider, exact reproduction steps, expected behavior, and the sanitized error code. Remove tokens, app passwords, email bodies, and personal addresses from logs.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue. Keep discussions respectful, focus feedback on the work, and do not post anyone else's private information.

Contributions are distributed under the project's [MIT license](LICENSE).

## Releases (maintainers)

Release only a reviewed commit after CI passes. Update the package version, lockfile, MCP server version in `src/server.ts`, and [CHANGELOG.md](CHANGELOG.md). Run the checks above, inspect `npm pack --dry-run`, and publish with `npm publish --access public`. Create a matching Git tag and GitHub release. Registry authentication and any requested npm 2FA must be completed by the maintainer; never commit publishing credentials.
