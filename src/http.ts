import { err, ok, okAsync } from "neverthrow";
import type { z } from "zod";

import { attempt, failure, MailFault, validate } from "./result.js";
import type { AsyncResult, ErrorCode, MailError } from "./result.js";
import type { TokenSession } from "./session.js";

export function httpFailure(response: Response, oauth = false): MailError {
  const { status } = response;
  const header = response.headers.get("retry-after");
  let retryAfterMs: number | undefined;
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now();
    if (Number.isFinite(delay)) {
      retryAfterMs = Math.max(0, delay);
    }
  }
  let code: ErrorCode = "INVALID_INPUT";
  if (status === 429) {
    code = "RATE_LIMITED";
  } else if (status >= 500) {
    code = "UNAVAILABLE";
  } else if (status === 401 || (oauth && status === 400)) {
    code = "AUTH_REQUIRED";
  } else if (status === 403) {
    code = "FORBIDDEN";
  } else if (status === 404) {
    code = "NOT_FOUND";
  }
  return failure(
    code,
    status === 429 || status === 503 ? retryAfterMs : undefined
  );
}

export function send(
  url: string | URL,
  options: RequestInit,
  fetcher: typeof fetch = fetch
): AsyncResult<Response> {
  return attempt(
    () =>
      fetcher(url, {
        ...options,
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(30_000),
      }),
    "NETWORK"
  );
}

export function json<T>(
  response: Response,
  schema: z.ZodType<T>
): AsyncResult<T> {
  return attempt(async () => {
    const maxBytes = 16 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new MailFault(failure("INVALID_RESPONSE"));
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        size += chunk.value.length;
        if (size > maxBytes) {
          throw new MailFault(failure("TOO_LARGE"));
        }
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
    } finally {
      // Cancellation errors must not hide a parse/transport/size error.
      await reader.cancel().catch(() => {
        // Best-effort cancellation must not replace the original error.
      });
      reader.releaseLock();
    }
  }, "INVALID_RESPONSE").andThen((value) =>
    validate(schema, value, "INVALID_RESPONSE")
  );
}

export function checkedJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  oauth = false
): AsyncResult<T> {
  return attempt(async () => {
    if (!response.ok) {
      await response.body?.cancel().catch(() => {
        // Best-effort cancellation must not replace the original error.
      });
      return err(httpFailure(response, oauth));
    }
    return ok(response);
  })
    .andThen((result) => result)
    .andThen((validResponse) => json(validResponse, schema));
}

export function authorizedJson<
  C extends { accessToken: string; expiresAt: number },
  T,
>(
  session: TokenSession<C>,
  url: string | URL,
  schema: z.ZodType<T>,
  fetcher: typeof fetch,
  headers: Record<string, string> = {}
): AsyncResult<T> {
  const request = (credentials: C) =>
    send(
      url,
      {
        headers: {
          ...headers,
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      },
      fetcher
    );
  return session
    .read()
    .andThen((credentials) =>
      request(credentials).andThen((response) => {
        if (response.status !== 401) {
          return okAsync(response);
        }
        return attempt(() =>
          response.body?.cancel().catch(() => {
            // Best-effort cancellation must not replace the original error.
          })
        )
          .andThen(() => session.refresh(credentials.accessToken))
          .andThen(request);
      })
    )
    .andThen((response) => checkedJson(response, schema));
}
