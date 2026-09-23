import { access, readdir, rm, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { failure, MailFault, validate } from "./result.js";
import {
  credentialsSchema,
  TokenStore,
  writePrivateJson,
  readStored,
} from "./store.js";
import type { CredentialStore, Credentials } from "./store.js";

export const accountId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  .refine(
    (id) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id),
    "Reserved account name"
  );
export const outlookCredentials = z.object({
  accessToken: z.string().min(1),
  clientId: z.string().min(1),
  expiresAt: z.number().finite(),
  refreshToken: z.string().min(1),
  tenant: z.string().regex(/^[a-zA-Z0-9.-]+$/),
});
export const imapCredentials = z.object({
  host: z.string().min(1),
  mailbox: z.string().min(1).default("INBOX"),
  password: z.string().min(1),
  port: z.number().int().min(1).max(65_535).default(993),
  user: z.string().min(1),
});
const accountSchema = z.discriminatedUnion("provider", [
  z.object({ credentials: credentialsSchema, provider: z.literal("gmail") }),
  z.object({ credentials: outlookCredentials, provider: z.literal("outlook") }),
  z.object({ credentials: imapCredentials, provider: z.literal("imap") }),
]);
export type Account = z.infer<typeof accountSchema>;
export type Provider = Account["provider"];
export type OutlookCredentials = z.infer<typeof outlookCredentials>;
export type ImapCredentials = z.infer<typeof imapCredentials>;
interface CredentialsByProvider {
  gmail: Credentials;
  outlook: OutlookCredentials;
  imap: ImapCredentials;
}

export class Accounts {
  constructor(readonly directory = join(homedir(), ".mail-mcp")) {}
  private path(id: string) {
    const parsed = validate(accountId, id);
    if (parsed.isErr()) {
      throw new MailFault(parsed.error);
    }
    return join(this.directory, "accounts", `${parsed.value}.json`);
  }

  async ids(): Promise<string[]> {
    let names: string[] = [];
    try {
      names = await readdir(join(this.directory, "accounts"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const ids = names
      .filter(
        (n) =>
          n.endsWith(".json") && accountId.safeParse(n.slice(0, -5)).success
      )
      .map((n) => n.slice(0, -5));
    try {
      await access(join(this.directory, "tokens.json"));
      ids.push("default");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return [...new Set(ids)].toSorted();
  }

  async read(id: string): Promise<Account> {
    try {
      return await readStored(this.path(id), accountSchema);
    } catch (error) {
      if (
        id === "default" &&
        error instanceof MailFault &&
        error.detail.code === "ACCOUNT_NOT_FOUND"
      ) {
        return {
          credentials: await new TokenStore(this.directory).read(),
          provider: "gmail",
        };
      }
      throw error;
    }
  }

  async save(id: string, account: Account) {
    accountId.parse(id);
    const value = accountSchema.parse(account);
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await chmod(this.directory, 0o700);
    await writePrivateJson(
      join(this.directory, "accounts"),
      `${id}.json`,
      value
    );
    // Only remove the legacy file after its replacement was safely written.
    if (id === "default") {
      await new TokenStore(this.directory).clear();
    }
  }

  async remove(id: string) {
    await rm(this.path(id), { force: true });
    if (id === "default") {
      await new TokenStore(this.directory).clear();
    }
  }

  credentials<P extends Provider>(
    id: string,
    provider: P
  ): CredentialStore<CredentialsByProvider[P]> {
    accountId.parse(id);
    return {
      directory: this.directory,
      read: async () => {
        const account = await this.read(id);
        if (account.provider !== provider) {
          throw new MailFault(failure("PROVIDER_CHANGED"));
        }
        return account.credentials as CredentialsByProvider[P];
      },
      save: async (credentials) =>
        this.save(id, { credentials, provider } as Account),
    };
  }
}
