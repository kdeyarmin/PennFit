// @workspace/resupply-email — transient-failure retry for outbound email.
//
// Every outbound email funnels through `createSendgridClient().sendEmail`
// (the "one From address" invariant). Many callers — synchronous HTTP
// routes, storefront fire-and-forget sends, per-recipient bulk-campaign
// loops — have NO job-queue retry behind them, so a single transient
// SendGrid blip (HTTP 429, a 5xx, or a network reset) surfaces as a hard
// failure even though the very next attempt would have succeeded.
//
// This module adds a small, bounded, in-process retry around the send so
// those brief blips self-heal. It is deliberately conservative:
//
//   - It ONLY retries errors that are definitively "not accepted by
//     SendGrid yet" — HTTP 429 (rate limited) and HTTP >= 500 (server
//     error), plus transport-layer errors that never reached SendGrid
//     (ECONNRESET / ETIMEDOUT / DNS failures). Those carry ZERO
//     duplicate-send risk: SendGrid rejected (or never saw) the request,
//     so re-sending the identical payload cannot produce two emails.
//   - It NEVER retries 4xx-other-than-429 (bad address, auth) — retrying
//     can't fix those — nor `EmailConfigError` (missing key), nor a 2xx
//     response with a malformed body (the email WAS accepted; retrying
//     would duplicate it).
//
// Backoff is short with full jitter because the hottest callers are
// synchronous routes with an admin waiting on the response. The happy
// path (first attempt succeeds) adds zero latency — no sleep is taken
// unless an attempt actually fails with a retryable error.

/** Node/undici transport error codes that mean "request never landed". */
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const NETWORK_ERROR_MESSAGE =
  /timeout|timed out|socket hang up|network|connection (?:reset|refused|closed)|econnreset|etimedout|enotfound|eai_again|fetch failed/i;

/**
 * Classify a raw error thrown by the SendGrid SDK as transient
 * (safe + worthwhile to retry) or terminal.
 *
 * The SendGrid SDK rejects with `{ code?, message?, response?: {
 * statusCode?, body? } }`. HTTP status lives in `response.statusCode`;
 * `code` is occasionally an HTTP status (number) but for transport
 * failures it is a string like "ECONNRESET".
 */
export function isTransientSendgridError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number | string;
    message?: unknown;
    response?: { statusCode?: number };
  };

  const httpStatus =
    typeof e.response?.statusCode === "number"
      ? e.response.statusCode
      : typeof e.code === "number"
        ? e.code
        : undefined;
  if (typeof httpStatus === "number") {
    // Got an HTTP response from SendGrid: retry only on rate-limit /
    // server errors. Any 4xx other than 429 is the caller's fault and
    // re-sending won't change the outcome.
    return httpStatus === 429 || httpStatus >= 500;
  }

  // No HTTP status at all → transport-layer failure that never reached
  // SendGrid. Retry when we recognise it as a network error; stay
  // conservative (don't retry) on truly unknown shapes to avoid masking
  // real bugs in a retry loop.
  if (typeof e.code === "string" && NETWORK_ERROR_CODES.has(e.code)) {
    return true;
  }
  if (typeof e.message === "string" && NETWORK_ERROR_MESSAGE.test(e.message)) {
    return true;
  }
  return false;
}

export interface RetryPolicy {
  /** Total attempts INCLUDING the first. `1` disables retry. */
  maxAttempts: number;
  /** Base backoff in ms; doubles each attempt (full-jitter applied). */
  baseDelayMs: number;
  /** Upper bound on a single backoff sleep, in ms. */
  maxDelayMs: number;
}

/**
 * Default email send policy: 3 attempts (so 2 retries), ~200ms then
 * ~400ms of jittered backoff — worst-case ~0.6s of added latency, only
 * ever paid when an attempt genuinely fails with a retryable error.
 */
export const DEFAULT_EMAIL_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
};

export interface WithRetryHooks {
  /** Predicate: should this thrown error be retried? */
  shouldRetry: (err: unknown) => boolean;
  /** Test seam — defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook fired before each backoff sleep. PHI-free. */
  onRetry?: (info: {
    attempt: number;
    nextDelayMs: number;
    err: unknown;
  }) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff: random integer in [0, min(cap, base*2^(attempt-1))). */
export function computeBackoffMs(attempt: number, policy: RetryPolicy): number {
  const exp = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exp);
  return Math.floor(Math.random() * capped);
}

/**
 * Run `fn`, retrying on retryable errors per `policy` + `hooks`.
 * Re-throws the last error once attempts are exhausted or the error is
 * classified terminal. The happy path takes no sleep.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  hooks: WithRetryHooks,
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, policy.maxAttempts);
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !hooks.shouldRetry(err)) {
        throw err;
      }
      const nextDelayMs = computeBackoffMs(attempt, policy);
      hooks.onRetry?.({ attempt, nextDelayMs, err });
      await sleep(nextDelayMs);
    }
  }
}
