import { err, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import type { z } from "zod";

const errors = {
  ACCOUNT_NOT_FOUND: [
    "Account not found. Register it with mail-mcp login.",
    false,
  ],
  ALL_FAILED: [
    "All requested accounts or messages failed. Inspect failures for individual errors.",
    false,
  ],
  AUTH_REQUIRED: [
    "Authentication expired or was rejected. Log in to this account again.",
    false,
  ],
  CREDENTIALS_INVALID: [
    "Saved credentials are invalid. Log in to this account again.",
    false,
  ],
  FORBIDDEN: [
    "The provider denied access. Check the granted mail permissions.",
    false,
  ],
  INTERNAL: ["An unexpected mail operation failed.", false],
  INVALID_INPUT: [
    "Invalid arguments. Check the account, message ID and search parameters.",
    false,
  ],
  INVALID_RESPONSE: [
    "The provider returned an invalid or unsupported response.",
    false,
  ],
  NETWORK: [
    "Could not connect to the mail provider. Check the connection and retry.",
    true,
  ],
  NOT_FOUND: ["The requested message or mailbox no longer exists.", false],
  PROVIDER_CHANGED: [
    "The account provider changed. Restart the server.",
    false,
  ],
  RATE_LIMITED: [
    "The provider rate limit was reached. Retry after the indicated delay.",
    true,
  ],
  STALE_CURSOR: [
    "The mailbox changed. Search again to obtain new message IDs and page tokens.",
    false,
  ],
  STORAGE: [
    "Cannot access credential storage. Check file permissions and available disk space.",
    false,
  ],
  TIMEOUT: ["The operation timed out. Retry later.", true],
  TOO_LARGE: [
    "The message or response exceeds the supported size limit.",
    false,
  ],
  UNAVAILABLE: [
    "The mail provider is temporarily unavailable. Retry later.",
    true,
  ],
} as const;
export type ErrorCode = keyof typeof errors;
export type MailError = Readonly<{
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  failures?: { account: string; id?: string; error: MailError }[];
}>;
export type AsyncResult<T> = ResultAsync<T, MailError>;

export function failure(code: ErrorCode, retryAfterMs?: number): MailError {
  const [message, retryable] = errors[code];
  return {
    code,
    message,
    retryable,
    ...(retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
      ? { retryAfterMs }
      : {}),
  };
}

// Only thrown inside Promise-based I/O adapters; domain APIs return ResultAsync.
// oxlint-disable-next-line unicorn/custom-error-definition -- Preserve the existing adapter error name.
export class MailFault extends Error {
  constructor(readonly detail: MailError) {
    super(detail.message);
    this.name = "MailFault";
  }
}

export function normalizeError(
  error: unknown,
  fallback: ErrorCode = "INTERNAL"
): MailError {
  if (error instanceof MailFault) {
    return error.detail;
  }
  const e = error as {
    name?: string;
    code?: string;
    authenticationFailed?: boolean;
    cause?: { code?: string };
  } | null;
  if (
    e?.name === "TimeoutError" ||
    e?.name === "AbortError" ||
    [
      "ETIMEDOUT",
      "ETIMEOUT",
      "CONNECT_TIMEOUT",
      "GREETING_TIMEOUT",
      "UPGRADE_TIMEOUT",
      "LockTimeout",
    ].includes(e?.code ?? "") ||
    e?.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return failure("TIMEOUT");
  }
  if (
    ["EACCES", "EPERM", "ENOSPC", "EROFS", "EISDIR", "ENOTDIR"].includes(
      e?.code ?? ""
    )
  ) {
    return failure("STORAGE");
  }
  if (e?.code?.startsWith("ERR_PARSE_ARGS_")) {
    return failure("INVALID_INPUT");
  }
  if (e?.code === "ETHROTTLE") {
    return failure("RATE_LIMITED");
  }
  if (
    [
      "InvalidResponse",
      "ResponseProcessingFailed",
      "ParserError",
      "UnexpectedTag",
    ].includes(e?.code ?? "")
  ) {
    return failure("INVALID_RESPONSE");
  }
  if (e?.authenticationFailed === true) {
    return failure("AUTH_REQUIRED");
  }
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "NoConnection",
      "ClosedAfterConnectTLS",
      "ClosedAfterConnectText",
    ].includes(e?.code ?? e?.cause?.code ?? "")
  ) {
    return failure("NETWORK");
  }
  return failure(fallback);
}

/** Capture synchronous throws AND rejected promises at an external I/O boundary. */
export function attempt<T>(
  action: () => T | PromiseLike<T>,
  fallback: ErrorCode = "INTERNAL"
): AsyncResult<T> {
  return ResultAsync.fromPromise(Promise.resolve().then(action), (error) =>
    normalizeError(error, fallback)
  );
}

/** Guard unexpected exceptions in callbacks, without nesting Result<Result<T>>. */
export function guard<T>(
  action: () => PromiseLike<Result<T, MailError>>
): AsyncResult<T> {
  return attempt(action).andThen((result) => result);
}

export function validate<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: ErrorCode = "INVALID_INPUT"
): Result<T, MailError> {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(failure(code));
}

/** Bridge only for imperative protocol/CLI adapters. Never use in domain composition. */
export async function valueOrThrow<T>(
  result: PromiseLike<Result<T, MailError>>
): Promise<T> {
  const resolved = await result;
  if (resolved.isErr()) {
    throw new MailFault(resolved.error);
  }
  return resolved.value;
}
