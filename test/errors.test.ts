import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ImapFlow } from "imapflow";
import { okAsync } from "neverthrow";
import { z } from "zod";

import { Accounts } from "../src/accounts.js";
import { Gmail } from "../src/gmail.js";
import { checkedJson } from "../src/http.js";
import { Imap } from "../src/imap.js";
import { Outlook } from "../src/outlook.js";
import { attempt, failure, guard, MailFault } from "../src/result.js";
import type { AsyncResult } from "../src/result.js";
import { createApp } from "../src/server.js";
import { MailService } from "../src/service.js";
import { TokenSession } from "../src/session.js";

const credentials = {
  accessToken: "old",
  clientId: "client",
  clientSecret: "SECRET",
  expiresAt: Date.now() + 3_600_000,
  refreshToken: "refresh",
};
async function errorCode<T>(result: AsyncResult<T>, code: string) {
  const resolved = await result;
  assert.ok(resolved.isErr());
  assert.equal(resolved.error.code, code);
  assert.ok(!JSON.stringify(resolved.error).includes("SECRET"));
  return resolved.error;
}

test("Result composition short-circuits sync/async failures and guards callback exceptions", async () => {
  const calls = { next: 0 };
  for (const operation of [
    () => {
      throw new Error("SECRET");
    },
    async () => {
      throw new Error("SECRET");
    },
  ]) {
    await errorCode(
      attempt(operation).andThen(() => {
        calls.next += 1;
        return okAsync("unexpected");
      }),
      "INTERNAL"
    );
  }
  assert.equal(calls.next, 0);
  await errorCode(
    guard(() =>
      okAsync(1).map(() => {
        throw new Error("SECRET");
      })
    ),
    "INTERNAL"
  );
  const recovered = await attempt(() => {
    throw new MailFault(failure("TIMEOUT"));
  }).orElse((error) => okAsync(error.code));
  assert.ok(recovered.isOk());
  assert.equal(recovered.value, "TIMEOUT");
});

test("HTTP errors preserve retry advice and reject malformed, oversized and invalid responses", async () => {
  const schema = z.object({ value: z.array(z.string()) });
  const rate = await errorCode(
    checkedJson(
      new Response("SECRET", { headers: { "retry-after": "2" }, status: 429 }),
      schema
    ),
    "RATE_LIMITED"
  );
  assert.equal(rate.retryable, true);
  assert.equal(rate.retryAfterMs, 2000);
  await errorCode(
    checkedJson(new Response("SECRET", { status: 401 }), schema),
    "AUTH_REQUIRED"
  );
  await errorCode(
    checkedJson(new Response("SECRET", { status: 403 }), schema),
    "FORBIDDEN"
  );
  await errorCode(
    checkedJson(new Response("SECRET", { status: 503 }), schema),
    "UNAVAILABLE"
  );
  await errorCode(
    checkedJson(new Response("SECRET"), schema),
    "INVALID_RESPONSE"
  );
  await errorCode(
    checkedJson(Response.json({ secret: "SECRET", value: 123 }), schema),
    "INVALID_RESPONSE"
  );
  let cancelled = false;
  const oversized = new ReadableStream({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
    },
  });
  await errorCode(checkedJson(new Response(oversized), schema), "TOO_LARGE");
  assert.ok(cancelled);
});

test("IMAP transport and authentication errors use SDK codes without exposing messages", async () => {
  for (const code of [
    "ETIMEOUT",
    "CONNECT_TIMEOUT",
    "GREETING_TIMEOUT",
    "LockTimeout",
  ]) {
    await errorCode(
      attempt(() => {
        throw Object.assign(new Error("SECRET"), { code });
      }),
      "TIMEOUT"
    );
  }
  await errorCode(
    attempt(() => {
      throw Object.assign(new Error("SECRET"), { code: "NoConnection" });
    }),
    "NETWORK"
  );
  await errorCode(
    attempt(() => {
      throw Object.assign(new Error("SECRET"), { authenticationFailed: true });
    }),
    "AUTH_REQUIRED"
  );
});

test("rotated credentials survive a failed disk write without repeating refresh", async () => {
  let saved = { ...credentials, expiresAt: 0 };
  let failSave = true;
  let renewals = 0;
  const session = new TokenSession(
    {
      directory: ".",
      read: async () => saved,
      save: async (value) => {
        if (failSave) {
          throw new Error("SECRET");
        }
        saved = value;
      },
    },
    (current) => {
      renewals += 1;
      return okAsync({
        ...current,
        accessToken: "new",
        expiresAt: Date.now() + 3_600_000,
        refreshToken: "rotated",
      });
    }
  );
  await errorCode(session.read(), "STORAGE");
  failSave = false;
  const results = await Promise.all([
    session.read(),
    session.read(),
    session.refresh("old"),
  ]);
  assert.ok(
    results.every(
      (result) => result.isOk() && result.value.refreshToken === "rotated"
    )
  );
  assert.equal(saved.refreshToken, "rotated");
  assert.equal(renewals, 1);
});

test("late 401 uses the already refreshed token and does not refresh twice", async () => {
  let stored = { ...credentials };
  let release!: () => void;
  const firstRetried = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldRequests = 0;
  let refreshes = 0;
  const gmail = new Gmail(
    {
      directory: ".",
      read: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    async (input, options) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        refreshes += 1;
        return Response.json({ access_token: "new", expires_in: 3600 });
      }
      if (new Headers(options?.headers).get("authorization") === "Bearer old") {
        oldRequests += 1;
        if (oldRequests === 2) {
          await firstRetried;
        }
        return new Response("SECRET", { status: 401 });
      }
      release();
      return Response.json({ messages: [] });
    }
  );
  await Promise.all([gmail.list({}), gmail.list({})]);
  assert.equal(oldRequests, 2);
  assert.equal(refreshes, 1);
});

test("MCP distinguishes all failures, partial success and successful empty searches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mail-errors-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const accounts = new Accounts(directory);
  await accounts.save("a", { credentials, provider: "gmail" });
  await accounts.save("b", { credentials, provider: "gmail" });
  const service = new MailService(accounts, (account) => ({
    get: async () => {
      throw new Error("SECRET");
    },
    list: async () => {
      if (account === "a") {
        throw new MailFault(failure("RATE_LIMITED", 2000));
      }
      return { messages: [] };
    },
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
    const { result } = (await response.json()) as any;
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    return {
      data: JSON.parse(result.content[0].text),
      isError: result.isError,
    };
  };
  const failed = await call("list_messages", { accounts: ["a"] });
  assert.equal(failed.isError, true);
  assert.equal(failed.data.error.code, "ALL_FAILED");
  assert.equal(failed.data.error.failures[0].error.code, "RATE_LIMITED");
  const partial = await call("list_messages", {});
  assert.ok(!partial.isError);
  assert.equal(partial.data.errors[0].error.retryAfterMs, 2000);
  const empty = await call("list_messages", { accounts: ["b"] });
  assert.ok(!empty.isError);
  assert.deepEqual(empty.data.messages, []);
  assert.equal(
    (await call("get_messages", { messages: [{ account: "a", id: "1" }] }))
      .isError,
    true
  );
  await writeFile(join(directory, "accounts", "a.json"), "SECRET invalid json");
  await writeFile(join(directory, "accounts", "b.json"), "SECRET invalid json");
  assert.equal(
    (await call("list_accounts", {})).data.error.failures[0].error.code,
    "CREDENTIALS_INVALID"
  );
});

test("invalid domain arguments do not reach providers; synchronous factory errors are values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mail-inputs-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const accounts = new Accounts(directory);
  await accounts.save("a", { credentials, provider: "gmail" });
  let calls = 0;
  const service = new MailService(accounts, () => {
    calls += 1;
    throw new Error("SECRET");
  });
  await errorCode(service.list({ accounts: ["a"], limit: 0 }), "INVALID_INPUT");
  await errorCode(service.getMany([]), "INVALID_INPUT");
  await errorCode(
    service.get({ account: "../escape", id: "x" }),
    "INVALID_INPUT"
  );
  assert.equal(calls, 0);
  await errorCode(service.get({ account: "a", id: "x" }), "INTERNAL");
  assert.equal(calls, 1);
  await errorCode(
    service.get({ account: "missing", id: "x" }),
    "ACCOUNT_NOT_FOUND"
  );
});

test("Outlook rejects cyclic attachment pages and invalid provider schemas", async () => {
  const store = {
    directory: ".",
    read: async () => ({ ...credentials, tenant: "common" }),
    save: async () => {},
  };
  let requests = 0;
  const outlook = new Outlook(store, async (input) => {
    requests += 1;
    if (String(input).includes("/attachments")) {
      return Response.json({
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/messages/1/attachments?$skip=1",
        value: [],
      });
    }
    return Response.json({ hasAttachments: true, id: "1" });
  });
  await errorCode(
    attempt(() => outlook.get("1")),
    "INVALID_RESPONSE"
  );
  assert.equal(requests, 3);
  const malformed = new Outlook(store, async () =>
    Response.json({ value: [{ id: 123, secret: "SECRET" }] })
  );
  await errorCode(
    attempt(() => malformed.list({})),
    "INVALID_RESPONSE"
  );
  const draft = new Outlook(store, async () =>
    Response.json({
      value: [
        {
          from: { emailAddress: null },
          id: "draft",
          receivedDateTime: null,
          subject: null,
        },
      ],
    })
  );
  assert.equal((await draft.list({})).messages[0]?.id, "draft");
  const gmail = new Gmail(store, async () =>
    Response.json({ messages: [{ id: "../SECRET" }] })
  );
  await errorCode(
    attempt(() => gmail.list({})),
    "INVALID_RESPONSE"
  );
});

test("IMAP does not report protocol failures as empty searches and closes connections", async () => {
  let released = 0;
  let closed = 0;
  const fake = Object.assign(new EventEmitter(), {
    close: () => {
      closed += 1;
    },
    connect: async () => {},
    getMailboxLock: async () => ({
      release() {
        released += 1;
      },
    }),
    mailbox: { uidValidity: 42n },
    search: async () => false,
  });
  const store = {
    directory: ".",
    read: async () => ({
      host: "example.com",
      mailbox: "INBOX",
      password: "SECRET",
      port: 993,
      user: "user",
    }),
    save: async () => {},
  };
  const imap = new Imap(store, () => fake as unknown as ImapFlow);
  await errorCode(
    attempt(() => imap.list({})),
    "INVALID_RESPONSE"
  );
  assert.equal(released, 1);
  assert.equal(closed, 1);
  fake.search = async () => {
    fake.emit(
      "error",
      Object.assign(new Error("SECRET"), { code: "ECONNRESET" })
    );
    return [] as any;
  };
  await errorCode(
    attempt(() => imap.list({})),
    "NETWORK"
  );
  assert.equal(released, 2);
  assert.equal(closed, 2);
});
