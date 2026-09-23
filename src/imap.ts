import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import type { ImapCredentials } from "./accounts.js";
import type { MailProvider, Search } from "./mail.js";
import { failure, MailFault } from "./result.js";
import type { CredentialStore } from "./store.js";

const maxMessageBytes = 10 * 1024 * 1024;
// Including UIDVALIDITY prevents a stale ID from resolving to a different message.
function decodeId(value: string) {
  if (!/^\d+:\d+$/.test(value)) {
    throw new MailFault(failure("INVALID_INPUT"));
  }
  const [validity, uid] = value.split(":");
  const number = Number(uid);
  if (!Number.isSafeInteger(number) || number < 1 || number > 0xff_ff_ff_ff) {
    throw new MailFault(failure("INVALID_INPUT"));
  }
  return { uid: number, validity };
}

export class Imap implements MailProvider {
  constructor(
    private store: CredentialStore<ImapCredentials>,
    private factory = (options: ConstructorParameters<typeof ImapFlow>[0]) =>
      new ImapFlow(options)
  ) {}

  private async connected<T>(
    action: (client: ImapFlow, validity: string) => Promise<T>
  ): Promise<T> {
    const credentials = await this.store.read();
    const client = this.factory({
      auth: { pass: credentials.password, user: credentials.user },
      connectionTimeout: 15_000,
      disableAutoIdle: true,
      greetingTimeout: 15_000,
      host: credentials.host,
      logger: false,
      port: credentials.port,
      secure: true,
      socketTimeout: 30_000,
    });
    let connectionError: unknown;
    client.on("error", (error) => {
      connectionError = error;
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(credentials.mailbox, {
        readOnly: true,
      });
      try {
        if (!client.mailbox) {
          throw new MailFault(failure("NOT_FOUND"));
        }
        const result = await action(client, String(client.mailbox.uidValidity));
        if (connectionError) {
          throw connectionError;
        }
        return result;
      } finally {
        lock.release();
      }
    } finally {
      client.close();
    }
  }

  async check() {
    await this.connected(async () => {
      // Always release the socket if graceful logout fails.
    });
  }

  async list({ text, limit = 20, pageToken }: Search) {
    return this.connected(async (client, validity) => {
      const cursor = pageToken ? decodeId(pageToken) : undefined;
      if (cursor && cursor.validity !== validity) {
        throw new MailFault(failure("STALE_CURSOR"));
      }
      if (cursor?.uid === 1) {
        return { messages: [] };
      }
      const found = await client.search(
        {
          ...(text ? { text } : { all: true }),
          ...(cursor ? { uid: `1:${cursor.uid - 1}` } : {}),
        },
        { uid: true }
      );
      if (!Array.isArray(found)) {
        throw new MailFault(failure("INVALID_RESPONSE"));
      }
      const uids = found.toSorted((a, b) => b - a);
      const selected = uids.slice(0, limit);
      if (!selected.length) {
        return { messages: [] };
      }
      const fetched = await client.fetchAll(
        selected,
        { envelope: true, flags: true, internalDate: true, uid: true },
        { uid: true }
      );
      const messages = fetched
        .toSorted((a, b) => b.uid - a.uid)
        .map((m) => ({
          date:
            m.internalDate instanceof Date
              ? m.internalDate.toISOString()
              : undefined,
          from: m.envelope?.from?.map((a) => a.address).join(", "),
          id: `${validity}:${m.uid}`,
          subject: m.envelope?.subject,
          unread: !m.flags?.has("\\Seen"),
        }));
      return {
        messages,
        nextPageToken:
          uids.length > limit ? `${validity}:${selected.at(-1)}` : undefined,
      };
    });
  }

  async get(id: string) {
    const messageId = decodeId(id);
    return this.connected(async (client, validity) => {
      if (messageId.validity !== validity) {
        throw new MailFault(failure("STALE_CURSOR"));
      }
      const metadata = await client.fetchOne(
        String(messageId.uid),
        { size: true, uid: true },
        { uid: true }
      );
      if (!metadata) {
        throw new MailFault(failure("NOT_FOUND"));
      }
      if ((metadata.size ?? 0) > maxMessageBytes) {
        throw new MailFault(failure("TOO_LARGE"));
      }
      const m = await client.fetchOne(
        String(messageId.uid),
        { flags: true, source: { maxLength: maxMessageBytes + 1 } },
        { uid: true }
      );
      if (!m || !m.source) {
        throw new MailFault(failure("NOT_FOUND"));
      }
      if (m.source.length > maxMessageBytes) {
        throw new MailFault(failure("TOO_LARGE"));
      }
      const parsed = await simpleParser(m.source, {
        skipHtmlToText: true,
        skipImageLinks: true,
        skipTextToHtml: true,
      });
      const to = Array.isArray(parsed.to)
        ? parsed.to.map((a) => a.text).join(", ")
        : parsed.to?.text;
      return {
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename ?? "",
          mimeType: a.contentType,
          size: a.size,
        })),
        date: parsed.date?.toISOString(),
        from: parsed.from?.text,
        html: parsed.html || "",
        id,
        subject: parsed.subject,
        text: parsed.text ?? "",
        to,
        unread: !m.flags?.has("\\Seen"),
      };
    });
  }
}
