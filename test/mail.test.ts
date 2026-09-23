import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { okAsync } from "neverthrow";

import { login } from "../src/auth.js";
import { Gmail } from "../src/gmail.js";
import { createApp } from "../src/server.js";
import type { MailService } from "../src/service.js";
import { TokenStore } from "../src/store.js";

const credentials = {
  accessToken: "test-access",
  clientId: "test-client",
  clientSecret: "test-secret",
  expiresAt: Date.now() + 3_600_000,
  refreshToken: "test-refresh",
};

async function temporaryStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "mail-mcp-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return new TokenStore(directory);
}

test("credentials round-trip, replace atomically, and logout", async (t) => {
  const store = await temporaryStore(t);
  await assert.rejects(store.read(), /Account not found/);
  await store.save(credentials);
  assert.deepEqual(await store.read(), credentials);
  await store.save({ ...credentials, accessToken: "new-access" });
  assert.equal((await store.read()).accessToken, "new-access");
  assert.deepEqual(await readdir(store.directory), ["tokens.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(store.directory, "tokens.json"))).mode & 0o777,
      0o600
    );
  }
  await store.clear();
  await assert.rejects(store.read(), /Account not found/);
});

test("expired tokens refresh once for concurrent requests and preserve the refresh token", async (t) => {
  const store = await temporaryStore(t);
  await store.save({ ...credentials, expiresAt: 0 });
  let refreshes = 0;
  const gmail = new Gmail(store, async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      refreshes += 1;
      assert.equal(
        (options?.body as URLSearchParams | undefined)?.get("refresh_token"),
        "test-refresh"
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    }
    assert.equal(
      new Headers(options?.headers).get("authorization"),
      "Bearer new-access"
    );
    assert.equal(url.searchParams.get("q"), "is:unread");
    assert.equal(url.searchParams.get("pageToken"), "page+2");
    return Response.json({ nextPageToken: "page3" });
  });
  const results = await Promise.all(
    [1, 2, 3].map(() => gmail.list({ pageToken: "page+2", query: "is:unread" }))
  );
  assert.equal(refreshes, 1);
  assert.deepEqual(results[0], { messages: [], nextPageToken: "page3" });
  assert.equal((await store.read()).refreshToken, "test-refresh");
});

test("401 refreshes once and retries; provider errors do not expose response bodies", async (t) => {
  const store = await temporaryStore(t);
  await store.save(credentials);
  let requests = 0;
  const gmail = new Gmail(store, async (input) => {
    if (String(input).includes("oauth2.googleapis.com")) {
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    }
    requests += 1;
    return new Response("secret provider body", { status: 401 });
  });
  await assert.rejects(gmail.list({}), {
    message:
      "Authentication expired or was rejected. Log in to this account again.",
    name: "MailFault",
  });
  assert.equal(requests, 2);
});

test("message decoding handles nested MIME parts and attachment metadata", async (t) => {
  const store = await temporaryStore(t);
  await store.save(credentials);
  const gmail = new Gmail(store, async () =>
    Response.json({
      id: "123",
      payload: {
        headers: [{ name: "Subject", value: "Test mail" }],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                body: {
                  data: Buffer.from("\u3053\u3093\u306B\u3061\u306F").toString(
                    "base64url"
                  ),
                },
                mimeType: "text/plain",
              },
              {
                body: {
                  data: Buffer.from("<p>Hello</p>").toString("base64url"),
                },
                mimeType: "text/html",
              },
            ],
          },
          {
            body: {
              data: Buffer.from("attachment").toString("base64url"),
              size: 10,
            },
            filename: "note.txt",
            mimeType: "text/plain",
          },
        ],
      },
      threadId: "456",
    })
  );
  const message = await gmail.get("123");
  assert.equal(message.subject, "Test mail");
  assert.equal(message.text, "\u3053\u3093\u306B\u3061\u306F");
  assert.equal(message.html, "<p>Hello</p>");
  assert.equal(message.attachments[0]?.filename, "note.txt");
});

test("real MCP HTTP client initializes, lists and calls tools, and validates arguments", async (t) => {
  const app = createApp({
    get: ({ id }: { id: string }) => okAsync({ id, text: "Hello" }),
    getMany: () => okAsync([]),
    list: () => okAsync({ messages: [{ id: "123", threadId: "456" }] }),
    listAccounts: () => okAsync([{ account: "personal", provider: "gmail" }]),
  } as unknown as MailService);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`)
    )
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["list_accounts", "list_messages", "get_message", "get_messages"]
  );
  const messages = await client.callTool({
    arguments: { query: "is:unread" },
    name: "list_messages",
  });
  assert.match(JSON.stringify(messages), /123/);
  const message = await client.callTool({
    arguments: { id: "123" },
    name: "get_message",
  });
  assert.match(JSON.stringify(message), /Hello/);
  const invalid = await client.callTool({
    arguments: { limit: 101 },
    name: "list_messages",
  });
  assert.equal(invalid.isError, true);
});

test("message body stored separately is fetched, but file attachments are not", async (t) => {
  const store = await temporaryStore(t);
  await store.save(credentials);
  const paths: string[] = [];
  const gmail = new Gmail(store, async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("/attachments/body-id")) {
      return Response.json({
        data: Buffer.from("Full message body").toString("base64url"),
      });
    }
    return Response.json({
      id: "123",
      payload: {
        parts: [
          {
            body: { attachmentId: "body-id", data: "" },
            mimeType: "text/plain",
          },
          {
            body: { attachmentId: "file-id" },
            filename: "file.txt",
            mimeType: "text/plain",
          },
          {
            body: { attachmentId: "unnamed-file-id" },
            headers: [{ name: "Content-Disposition", value: "attachment" }],
            mimeType: "text/plain",
          },
        ],
      },
      threadId: "456",
    });
  });
  const message = await gmail.get("123");
  assert.equal(message.text, "Full message body");
  assert.equal(message.attachments.length, 2);
  assert.deepEqual(paths, [
    "/gmail/v1/users/me/messages/123",
    "/gmail/v1/users/me/messages/123/attachments/body-id",
  ]);
});

test("message body uses the MIME charset instead of assuming UTF-8", async (t) => {
  const store = await temporaryStore(t);
  await store.save(credentials);
  const gmail = new Gmail(store, async () =>
    Response.json({
      id: "123",
      payload: {
        body: { data: Buffer.from([0x82, 0xa0]).toString("base64url") },
        headers: [
          { name: "Content-Type", value: 'text/plain; charset="Shift_JIS"' },
        ],
        mimeType: "text/plain",
      },
      threadId: "456",
    })
  );
  assert.equal((await gmail.get("123")).text, "\u3042");
});

test("HTTP rejects foreign hosts and browser origins", async () => {
  const app = createApp({} as MailService);
  assert.equal(
    (await app.request("http://evil.example/mcp", { method: "POST" })).status,
    403
  );
  assert.equal(
    (
      await app.request("http://localhost:3000/mcp", {
        headers: { origin: "https://evil.example" },
        method: "POST",
      })
    ).status,
    403
  );
});

test("login validates state, uses PKCE and saves exchanged tokens", async (t) => {
  const store = await temporaryStore(t);
  const path = join(store.directory, "client.json");
  await writeFile(
    path,
    JSON.stringify({
      installed: { client_id: "client", client_secret: "secret" },
    })
  );
  let receivedUrl!: (url: URL) => void;
  const urlReady = new Promise<URL>((resolve) => {
    receivedUrl = resolve;
  });
  t.mock.method(console, "error", (message: string) => {
    if (message.startsWith("Open this URL")) {
      receivedUrl(new URL(message.split("\n")[1]!));
    }
  });
  const realFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) !== "https://oauth2.googleapis.com/token") {
        return realFetch(input, options);
      }
      const params = options?.body as URLSearchParams;
      assert.equal(params.get("code"), "test-code");
      assert.equal(
        createHash("sha256")
          .update(params.get("code_verifier")!)
          .digest("base64url"),
        (await urlReady).searchParams.get("code_challenge")
      );
      return Response.json({
        access_token: "access",
        expires_in: 3600,
        refresh_token: "refresh",
      });
    }
  );
  const pending = login(store, path);
  const authUrl = await urlReady;
  const callback = new URL(authUrl.searchParams.get("redirect_uri")!);
  const malformedStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = httpRequest(
        { hostname: callback.hostname, path: "//[", port: callback.port },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end();
    }
  );
  assert.equal(malformedStatus, 400);
  callback.search = new URLSearchParams({
    code: "test-code",
    state: "wrong",
  }).toString();
  assert.equal((await realFetch(callback)).status, 400);
  callback.searchParams.set("state", authUrl.searchParams.get("state")!);
  assert.equal((await realFetch(callback)).status, 200);
  await pending;
  assert.equal((await store.read()).refreshToken, "refresh");
  assert.ok(
    !(await readFile(join(store.directory, "tokens.json"), "utf-8")).includes(
      "code_verifier"
    )
  );
});
