import { err, errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { accountId } from "./accounts.js";
import type { Accounts, Account, Provider } from "./accounts.js";
import { Gmail } from "./gmail.js";
import { Imap } from "./imap.js";
import { mapLimit } from "./mail.js";
import type { MailProvider, Summary } from "./mail.js";
import { Outlook } from "./outlook.js";
import { attempt, failure, guard, validate } from "./result.js";
import type { MailError } from "./result.js";

const refSchema = z.object({
  account: accountId.optional(),
  id: z.string().min(1).max(4000),
});
const listSchema = z
  .object({
    accounts: z.array(accountId).min(1).max(100).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    pageToken: z.string().min(1).max(16_000).optional(),
    pageTokens: z
      .record(accountId, z.string().min(1).max(16_000))
      .refine((tokens) => Object.keys(tokens).length <= 100)
      .optional(),
    query: z.string().max(1000).optional(),
    text: z.string().max(1000).optional(),
  })
  .refine((i) => !(i.text && i.query) && !(i.pageToken && i.pageTokens));
export type ListInput = z.input<typeof listSchema>;
export type MessageRef = z.infer<typeof refSchema>;
interface AccountFailure {
  account: string;
  id?: string;
  error: MailError;
}
const allFailed = (failures: AccountFailure[]): MailError => ({
  ...failure("ALL_FAILED"),
  failures,
  retryable: failures.some((f) => f.error.retryable),
});

export class MailService {
  private clients = new Map<
    string,
    { provider: Provider; client: MailProvider }
  >();
  constructor(
    private accounts: Accounts,
    private factory?: (id: string, account: Account) => MailProvider
  ) {}

  private client(id: string) {
    return attempt(() => this.accounts.read(id), "STORAGE").map((account) => {
      const cached = this.clients.get(id);
      if (cached?.provider === account.provider) {
        return cached;
      }
      let client: MailProvider;
      if (this.factory) {
        client = this.factory(id, account);
      } else if (account.provider === "gmail") {
        const gmail = new Gmail(this.accounts.credentials(id, "gmail"));
        client = {
          get: (messageId) => gmail.get(messageId),
          list: (input) => gmail.search(input),
        };
      } else if (account.provider === "outlook") {
        client = new Outlook(this.accounts.credentials(id, "outlook"));
      } else {
        client = new Imap(this.accounts.credentials(id, "imap"));
      }
      const value = { client, provider: account.provider };
      this.clients.set(id, value);
      return value;
    });
  }

  listAccounts() {
    return guard(() =>
      attempt(() => this.accounts.ids(), "STORAGE")
        .andThen((ids) =>
          attempt(() =>
            mapLimit(ids, 4, (id) =>
              attempt(() => this.accounts.read(id), "STORAGE").match(
                (account) => ({
                  account: id,
                  provider: account.provider,
                  ...(account.provider === "imap"
                    ? { mailbox: account.credentials.mailbox }
                    : {}),
                }),
                (error) => ({ account: id, error })
              )
            )
          )
        )
        .andThen((rows) =>
          rows.length && rows.every((row) => "error" in row)
            ? err(allFailed(rows))
            : ok(rows)
        )
    );
  }

  list(input: ListInput) {
    return guard(() =>
      okAsync(input)
        .andThen((i) => validate(listSchema, i))
        .andThen((i) =>
          attempt(
            () =>
              i.accounts ??
              (i.pageTokens ? Object.keys(i.pageTokens) : this.accounts.ids()),
            "STORAGE"
          ).andThen((ids) => {
            const selected = [...new Set(ids)];
            if ((i.query || i.pageToken) && selected.length !== 1) {
              return errAsync(failure("INVALID_INPUT"));
            }
            if (
              i.pageTokens &&
              selected.some((id) => !Object.hasOwn(i.pageTokens ?? {}, id))
            ) {
              return errAsync(failure("INVALID_INPUT"));
            }
            const providerCheck = i.query
              ? attempt(
                  () => this.accounts.read(selected[0] ?? ""),
                  "STORAGE"
                ).andThen((a) =>
                  a.provider === "gmail" ? ok() : err(failure("INVALID_INPUT"))
                )
              : okAsync();
            return providerCheck
              .andThen(() =>
                attempt(() =>
                  mapLimit(selected, 4, (id) =>
                    guard(() =>
                      this.client(id).andThen(({ client, provider }) =>
                        attempt(() =>
                          client.list({
                            limit: i.limit,
                            pageToken: i.pageTokens?.[id] ?? i.pageToken,
                            query: i.query,
                            text: i.text,
                          })
                        ).map((page) => ({ id, page, provider }))
                      )
                    ).match(
                      (value) => ({ value }),
                      (error) => ({ error: { account: id, error } })
                    )
                  )
                )
              )
              .andThen((rows) => {
                const messages: (Summary & {
                  account: string;
                  provider: Provider;
                })[] = [];
                const errors: AccountFailure[] = [];
                const nextPageTokens: Record<string, string> =
                  Object.create(null);
                for (const row of rows) {
                  if ("error" in row) {
                    errors.push(row.error);
                    continue;
                  }
                  const { id, provider, page } = row.value;
                  messages.push(
                    ...page.messages.map((m) => ({
                      ...m,
                      account: id,
                      provider,
                    }))
                  );
                  if (page.nextPageToken) {
                    nextPageTokens[id] = page.nextPageToken;
                  }
                }
                if (rows.length && errors.length === rows.length) {
                  return err(allFailed(errors));
                }
                const timestamp = (date?: string) =>
                  date ? Date.parse(date) || 0 : 0;
                messages.sort(
                  (a, b) =>
                    timestamp(b.date) - timestamp(a.date) ||
                    a.account.localeCompare(b.account) ||
                    a.id.localeCompare(b.id)
                );
                return ok({ errors, messages, nextPageTokens });
              });
          })
        )
    );
  }

  get(reference: MessageRef) {
    return guard(() =>
      okAsync(reference)
        .andThen((ref) => validate(refSchema, ref))
        .andThen((ref) => {
          const selectedAccount = ref.account
            ? okAsync(ref.account)
            : attempt(() => this.accounts.ids(), "STORAGE").andThen((ids) =>
                ids.length === 1 && ids[0] !== undefined
                  ? ok(ids[0])
                  : err(failure("INVALID_INPUT"))
              );
          return selectedAccount.andThen((account) =>
            this.client(account).andThen(({ client, provider }) =>
              attempt(() => client.get(ref.id)).map((message) => ({
                account,
                message,
                provider,
              }))
            )
          );
        })
    );
  }

  getMany(references: (MessageRef & { account: string })[]) {
    return guard(() =>
      okAsync(references)
        .andThen((refs) =>
          validate(
            z
              .array(refSchema.extend({ account: accountId }))
              .min(1)
              .max(20),
            refs
          )
        )
        .andThen((refs) =>
          attempt(() =>
            mapLimit(refs, 4, (ref) =>
              this.get(ref).match(
                (value) => ({ id: ref.id, ...value }),
                (error) => ({ account: ref.account, error, id: ref.id })
              )
            )
          )
        )
        .andThen((rows) =>
          rows.every((row) => "error" in row) ? err(allFailed(rows)) : ok(rows)
        )
    );
  }
}
