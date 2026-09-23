import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import type { ImapFlow } from "imapflow";

import { Accounts } from "../src/accounts.js";
import type { OutlookCredentials } from "../src/accounts.js";
import { Gmail } from "../src/gmail.js";
import { Imap } from "../src/imap.js";
import { Outlook, loginOutlook } from "../src/outlook.js";
import { valueOrThrow } from "../src/result.js";
import { createApp } from "../src/server.js";
import { MailService } from "../src/service.js";
import { TokenStore } from "../src/store.js";

const gmail = {
  accessToken: "access",
  clientId: "client",
  clientSecret: "secret",
  expiresAt: Date.now() + 3_600_000,
  refreshToken: "refresh",
};
const outlook: OutlookCredentials = {
  accessToken: "outlook-access",
  clientId: "client",
  expiresAt: Date.now() + 3_600_000,
  refreshToken: "outlook-refresh",
  tenant: "common",
};
const imap = {
  host: "imap.example.com",
  mailbox: "INBOX",
  password: "app-password",
  port: 993,
  user: "test@example.com",
};

async function vault(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "mail-multi-test-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return new Accounts(dir);
}

test("legacy Gmail credentials migrate on save without losing another account", async (t) => {
  const accounts = await vault(t);
  const legacy = new TokenStore(accounts.directory);
  await legacy.save(gmail);
  await accounts.save("work", { credentials: outlook, provider: "outlook" });
  assert.deepEqual(await accounts.ids(), ["default", "work"]);
  assert.equal((await accounts.read("default")).provider, "gmail");
  await accounts
    .credentials("default", "gmail")
    .save({ ...gmail, accessToken: "new" });
  assert.ok(!(await readdir(accounts.directory)).includes("tokens.json"));
  assert.equal(
    (await accounts.credentials("default", "gmail").read()).accessToken,
    "new"
  );
  await accounts.remove("default");
  assert.deepEqual(await accounts.ids(), ["work"]);
  assert.equal(
    (await accounts.credentials("work", "outlook").read()).refreshToken,
    "outlook-refresh"
  );
});

test("account paths cannot escape storage; account listing never exposes credentials", async (t) => {
  const accounts = await vault(t);
  for (const id of ["../escape", "a/b", "a\\b", "CON", "con", "nul", "UPPER"]) {
    await assert.rejects(
      accounts.save(id, { credentials: gmail, provider: "gmail" })
    );
  }
  await accounts.save("personal", { credentials: gmail, provider: "gmail" });
  await accounts.save("other", { credentials: imap, provider: "imap" });
  await writeFile(
    join(accounts.directory, "accounts", "broken.json"),
    "invalid json secret"
  );
  const listed = await valueOrThrow(new MailService(accounts).listAccounts());
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes("secret"));
  assert.ok(!serialized.includes("password"));
  assert.ok(!serialized.includes("outlook-access"));
  assert.ok(listed.some((a) => a.account === "broken" && "error" in a));
  assert.ok(
    listed.some((a) => a.account === "personal" && a.provider === "gmail")
  );
});

test("cross-provider search isolates failures and pagination does not restart completed accounts", async (t) => {
  const accounts = await vault(t);
  await accounts.save("personal", { credentials: gmail, provider: "gmail" });
  await accounts.save("work", { credentials: outlook, provider: "outlook" });
  await accounts.save("other", { credentials: imap, provider: "imap" });
  const calls: {
    account: string;
    text?: string;
    page?: string;
    limit?: number;
  }[] = [];
  const service = new MailService(accounts, (id) => ({
    get: async () => ({}),
    list: async (input) => {
      calls.push({
        account: id,
        limit: input.limit,
        page: input.pageToken,
        text: input.text,
      });
      if (id === "other") {
        throw new Error("app-password must not leak");
      }
      return {
        messages: [
          {
            date:
              id === "work" ? "2026-09-23T10:00:00Z" : "2026-09-22T10:00:00Z",
            id: "same-id",
            subject: id,
          },
        ],
        nextPageToken:
          id === "personal" && !input.pageToken ? "next" : undefined,
      };
    },
  }));
  const first = await valueOrThrow(service.list({ limit: 3, text: "invoice" }));
  assert.deepEqual(
    first.messages.map((m) => m.account),
    ["work", "personal"]
  );
  assert.deepEqual(
    first.messages.map((m) => m.provider),
    ["outlook", "gmail"]
  );
  assert.equal(first.errors[0]?.account, "other");
  assert.ok(!JSON.stringify(first).includes("app-password"));
  assert.ok(calls.every((c) => c.text === "invoice" && c.limit === 3));
  calls.length = 0;
  const second = await valueOrThrow(
    service.list({
      limit: 3,
      pageTokens: first.nextPageTokens,
      text: "invoice",
    })
  );
  assert.deepEqual(calls, [
    { account: "personal", limit: 3, page: "next", text: "invoice" },
  ]);
  assert.equal(second.messages.length, 1);
  assert.equal(
    (await valueOrThrow(service.list({ pageTokens: {} }))).messages.length,
    0
  );
  await assert.rejects(
    valueOrThrow(service.list({ query: "is:unread" })),
    /Invalid arguments/
  );
  await assert.rejects(
    valueOrThrow(service.list({ accounts: ["work"], query: "is:unread" })),
    /Invalid arguments/
  );
});

test("batch reads route identical IDs to the right account and retain partial results", async (t) => {
  const accounts = await vault(t);
  await accounts.save("a", { credentials: gmail, provider: "gmail" });
  await accounts.save("b", { credentials: gmail, provider: "gmail" });
  const service = new MailService(accounts, (account) => ({
    get: async (id) => {
      if (id === "fail") {
        throw new Error("sensitive upstream error");
      }
      return { text: `${account}/${id}` };
    },
    list: async () => ({ messages: [] }),
  }));
  await assert.rejects(
    valueOrThrow(service.get({ id: "same" })),
    /Invalid arguments/
  );
  const result = await valueOrThrow(
    service.getMany([
      { account: "a", id: "same" },
      { account: "b", id: "same" },
      { account: "a", id: "fail" },
    ])
  );
  assert.deepEqual(
    result.slice(0, 2).map((r) => "message" in r && r.message),
    [{ text: "a/same" }, { text: "b/same" }]
  );
  assert.ok("error" in result[2]!);
  assert.ok(!JSON.stringify(result).includes("sensitive upstream"));
});

test("MCP exposes cross-account search and batch reads with validated account references", async (t) => {
  const accounts = await vault(t);
  await accounts.save("work", { credentials: outlook, provider: "outlook" });
  const service = new MailService(accounts, () => ({
    get: async (id) => ({ id, text: "message" }),
    list: async (input) => ({
      messages: [{ id: "id/+=", subject: input.text }],
    }),
  }));
  const app = createApp(service);
  const call = async (name: string, args: unknown) => {
    const response = await app.request("http://localhost/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    });
    return ((await response.json()) as any).result;
  };
  const search = await call("list_messages", { text: "invoice" });
  assert.equal(JSON.parse(search.content[0].text).messages[0].account, "work");
  assert.equal(
    JSON.parse(search.content[0].text).messages[0].subject,
    "invoice"
  );
  const batch = await call("get_messages", {
    messages: [{ account: "work", id: "id/+=" }],
  });
  assert.equal(JSON.parse(batch.content[0].text)[0].message.text, "message");
  assert.equal(
    (await call("get_message", { account: "../escape", id: "x" })).isError,
    true
  );
});

test("Gmail cross-provider keywords are quoted and metadata is returned", async (t) => {
  const accounts = await vault(t);
  await accounts.save("gmail", { credentials: gmail, provider: "gmail" });
  const client = new Gmail(
    accounts.credentials("gmail", "gmail"),
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages")) {
        assert.equal(url.searchParams.get("q"), '"invoice"');
        return Response.json({
          messages: [{ id: "1" }],
          nextPageToken: "next",
        });
      }
      assert.equal(url.searchParams.get("format"), "metadata");
      return Response.json({
        id: "1",
        labelIds: ["UNREAD"],
        payload: { headers: [{ name: "Subject", value: "Invoice" }] },
      });
    }
  );
  const page = await client.search({ text: "invoice" });
  assert.equal(page.messages[0]?.subject, "Invoice");
  assert.equal(page.messages[0]?.unread, true);
  assert.equal(page.nextPageToken, "next");
  await assert.rejects(client.get("../profile"), /Invalid arguments/);
});

test("Outlook refresh rotation, keyword search and pagination preserve account scope", async (t) => {
  const accounts = await vault(t);
  await accounts.save("work", {
    credentials: { ...outlook, expiresAt: 0 },
    provider: "outlook",
  });
  const urls: URL[] = [];
  const client = new Outlook(
    accounts.credentials("work", "outlook"),
    async (input, options) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.hostname === "login.microsoftonline.com") {
        return Response.json({
          access_token: "new-access",
          expires_in: 3600,
          refresh_token: "rotated-refresh",
        });
      }
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        "Bearer new-access"
      );
      assert.equal(
        new Headers(options?.headers).get("prefer"),
        'IdType="ImmutableId"'
      );
      return Response.json({
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/messages?$skip=20",
        value: [{ id: "outlook-id", isRead: false, subject: "Invoice" }],
      });
    }
  );
  const first = await client.list({ limit: 2, text: "invoice" });
  assert.equal(urls[1]?.searchParams.get("$search"), '"invoice"');
  assert.equal(
    (await accounts.credentials("work", "outlook").read()).refreshToken,
    "rotated-refresh"
  );
  await client.list({ pageToken: first.nextPageToken });
  assert.equal(urls.at(-1)?.searchParams.get("$skip"), "20");
  const before = urls.length;
  await assert.rejects(
    client.list({ pageToken: "https://evil.example/v1.0/me/messages" }),
    /Invalid arguments/
  );
  assert.equal(urls.length, before);
});

test("Microsoft device login handles pending and slow_down before saving an account", async (t) => {
  const accounts = await vault(t);
  t.mock.method(console, "error", () => {});
  const waits: number[] = [];
  let polls = 0;
  await loginOutlook(
    accounts.credentials("work", "outlook"),
    "client",
    "common",
    async (input, options) => {
      if (String(input).endsWith("/devicecode")) {
        assert.equal(
          (options?.body as URLSearchParams | undefined)?.get("scope"),
          "https://graph.microsoft.com/Mail.Read offline_access"
        );
        return Response.json({
          device_code: "device",
          expires_in: 900,
          interval: 5,
          user_code: "ABCD",
          verification_uri: "https://microsoft.com/devicelogin",
        });
      }
      polls += 1;
      if (polls <= 2) {
        return Response.json(
          { error: polls === 1 ? "authorization_pending" : "slow_down" },
          { status: 400 }
        );
      }
      return Response.json({
        access_token: "access",
        expires_in: 3600,
        refresh_token: "refresh",
      });
    },
    async (ms) => {
      waits.push(ms);
    }
  );
  assert.deepEqual(waits, [5000, 5000, 10_000]);
  assert.equal((await accounts.read("work")).provider, "outlook");
});

function fakeImap(overrides: Record<string, unknown> = {}) {
  return Object.assign(new EventEmitter(), {
    close: () => {},
    connect: async () => {},
    fetchAll: async (uids: number[], _query: unknown, options: unknown) => {
      assert.deepEqual(options, { uid: true });
      return uids.map((uid) => ({
        envelope: { subject: `mail-${uid}` },
        flags: new Set(),
        uid,
      }));
    },
    getMailboxLock: async (_mailbox: string, options: unknown) => {
      assert.deepEqual(options, { readOnly: true });
      return { release() {} };
    },
    mailbox: { uidValidity: 42n },
    search: async () => [1, 3, 5],
    ...overrides,
  }) as unknown as ImapFlow;
}

test("IMAP uses TLS, read-only mailbox locks, UID pagination and rejects stale message IDs", async (t) => {
  const accounts = await vault(t);
  await accounts.save("other", { credentials: imap, provider: "imap" });
  let query: unknown;
  const client = new Imap(accounts.credentials("other", "imap"), (options) => {
    assert.equal(options.secure, true);
    assert.equal(options.logger, false);
    return fakeImap({
      search: async (search: unknown) => {
        query = search;
        return [1, 3, 5];
      },
    });
  });
  const first = await client.list({ limit: 2, text: "invoice" });
  assert.deepEqual(query, { text: "invoice" });
  assert.deepEqual(
    first.messages.map((m) => m.id),
    ["42:5", "42:3"]
  );
  assert.equal(first.nextPageToken, "42:3");
  await client.list({ pageToken: first.nextPageToken, text: "invoice" });
  assert.deepEqual(query, { text: "invoice", uid: "1:2" });
  await assert.rejects(client.get("41:5"), /mailbox changed/);
});

test("IMAP reading parses MIME, preserves read-only access and bounds download size", async (t) => {
  const accounts = await vault(t);
  await accounts.save("other", { credentials: imap, provider: "imap" });
  const source = Buffer.from(
    "From: a@example.com\r\nTo: b@example.com\r\nSubject: Test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n"
  );
  let size = source.length;
  let sourceFetches = 0;
  const client = new Imap(accounts.credentials("other", "imap"), () =>
    fakeImap({
      fetchOne: async (_id: string, query: any, options: unknown) => {
        assert.deepEqual(options, { uid: true });
        if (query.size) {
          return { size, uid: 5 };
        }
        sourceFetches += 1;
        assert.equal(query.source.maxLength, 10 * 1024 * 1024 + 1);
        return { flags: new Set(), source, uid: 5 };
      },
    })
  );
  const message = await client.get("42:5");
  assert.equal(message.subject, "Test");
  assert.equal(message.text.trim(), "Hello");
  assert.equal(message.unread, true);
  size = 11 * 1024 * 1024;
  await assert.rejects(client.get("42:5"), /size limit/);
  assert.equal(sourceFetches, 1);
});
