#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { serve } from "@hono/node-server";

import { Accounts, accountId, imapCredentials } from "./accounts.js";
import { login } from "./auth.js";
import { Imap } from "./imap.js";
import { loginOutlook } from "./outlook.js";
import { valueOrThrow, MailFault, normalizeError } from "./result.js";
import { createApp } from "./server.js";
import { MailService } from "./service.js";

class CliInputError extends Error {
  override name = "CliInputError";
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      account: { type: "string" },
      "client-id": { type: "string" },
      credentials: { type: "string" },
      help: { short: "h", type: "boolean" },
      port: { default: "3000", type: "string" },
      provider: { default: "gmail", type: "string" },
      tenant: { default: "common", type: "string" },
    },
  });
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
MCP endpoint: http://127.0.0.1:3000/mcp`);
    return;
  }
  if (positionals.length > 1) {
    throw new CliInputError("Expected one command: login, serve, or logout.");
  }
  const accounts = new Accounts();
  const id = accountId.parse(values.account ?? "default");
  switch (positionals[0] ?? "serve") {
    case "login": {
      const existing = await accounts.ids();
      if (existing.includes(id)) {
        try {
          if ((await accounts.read(id)).provider !== values.provider) {
            throw new CliInputError(
              "This account name belongs to another provider. Choose a different --account name or log it out first."
            );
          }
        } catch (error) {
          if (
            !(
              error instanceof MailFault &&
              error.detail.code === "CREDENTIALS_INVALID"
            )
          ) {
            throw error;
          }
        }
      }
      if (values.provider === "gmail") {
        if (!values.credentials) {
          throw new CliInputError(
            "Gmail login requires --credentials <google-desktop-client.json>."
          );
        }
        await login(accounts.credentials(id, "gmail"), values.credentials);
      } else if (values.provider === "outlook") {
        if (!values["client-id"]) {
          throw new CliInputError(
            "Outlook login requires --client-id <app-id>."
          );
        }
        await loginOutlook(
          accounts.credentials(id, "outlook"),
          values["client-id"],
          values.tenant
        );
      } else if (values.provider === "imap") {
        if (!values.credentials) {
          throw new CliInputError(
            "IMAP login requires --credentials <imap.json>."
          );
        }
        const credentials = imapCredentials.parse(
          JSON.parse(await readFile(values.credentials, "utf-8"))
        );
        const provider = new Imap({
          directory: accounts.directory,
          read: async () => credentials,
          save: async () => {
            // Login validation does not persist credentials.
          },
        });
        try {
          await provider.check();
        } catch {
          throw new CliInputError(
            "IMAP connection failed. Check the TLS host, port, mailbox and app password."
          );
        }
        await accounts.save(id, { credentials, provider: "imap" });
        console.error(`IMAP account "${id}" saved.`);
      } else {
        throw new CliInputError("Provider must be gmail, outlook, or imap.");
      }
      break;
    }
    case "accounts": {
      console.log(
        JSON.stringify(
          await valueOrThrow(new MailService(accounts).listAccounts()),
          null,
          2
        )
      );
      break;
    }
    case "logout": {
      if (!values.account && (await accounts.ids()).length > 1) {
        throw new CliInputError("Specify --account to log out one account.");
      }
      await accounts.remove(
        values.account ?? (await accounts.ids())[0] ?? "default"
      );
      console.error("Local account credentials removed.");
      break;
    }
    case "serve": {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new CliInputError("Port must be an integer between 1 and 65535.");
      }
      if (!(await accounts.ids()).length) {
        throw new CliInputError(
          "No accounts registered. Run mail-mcp login first."
        );
      }
      const server = serve(
        {
          fetch: createApp(new MailService(accounts)).fetch,
          hostname: "127.0.0.1",
          port,
        },
        () => {
          console.error(`Mail MCP listening at http://127.0.0.1:${port}/mcp`);
        }
      );
      server.on("error", () => {
        console.error(
          "Could not start the server. Check whether the port is already in use."
        );
        process.exitCode = 1;
      });
      const shutdown = () => {
        server.close();
        if ("closeAllConnections" in server) {
          server.closeAllConnections();
        }
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      break;
    }
    default: {
      throw new CliInputError("Unknown command. Use mail-mcp --help.");
    }
  }
}

main().catch((error) => {
  let { message } = normalizeError(error);
  if (error instanceof CliInputError) {
    ({ message } = error);
  } else if (
    error instanceof Error &&
    ["ZodError", "SyntaxError"].includes(error.name)
  ) {
    message = "Invalid account name or credentials JSON. See mail-mcp --help.";
  }
  console.error(message);
  process.exitCode = 1;
});
