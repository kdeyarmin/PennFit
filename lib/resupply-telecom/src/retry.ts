// @workspace/resupply-telecom — transient-failure retry for outbound SMS.
//
// Mirrors @workspace/resupply-email/src/retry.ts. Every outbound SMS
// funnels through `createTwilioSmsClient().sendSms`, and many callers
// (synchronous routes, storefront best-effort sends, per-recipient bulk
// loops) have no job-queue retry behind them. A single transient Twilio
// blip (HTTP 429, a 5xx, or a network reset) otherwise fails the send
// outright even though the next attempt would have gone through.
//
// Conservative by design — it ONLY retries failures that mean "Twilio
// has not accepted the message yet" (HTTP 429 / >= 500 / transport-layer
// error), which carry zero duplicate-send risk. It NEVER retries Twilio
// 4xx (invalid number, blocked recipient, opt-out) — those are terminal
// and re-sending cannot help — nor `TwilioConfigError`.
//
// IMPORTANT: Twilio's error object puts the HTTP status on `.status` and
// a Twilio-specific *error code* (e.g. 21610 "blocked by recipient") on
// `.code`. `.code` is NOT an HTTP status, so retry classification keys
// off `.status` only.

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
 * Classify a raw error thrown by the Twilio SDK as transient (safe to
 * retry) or terminal. HTTP status is read from `.status`; transport
 * errors have no `.status` and surface a string `.code` / message.
 */
export function isTransientTwilioError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    code?: number | string;
    message?: unknown;
  };

  if (typeof e.status === "number") {
    // Got an HTTP response: retry only on rate-limit / server error.
    return e.status === 429 || e.status >= 500;
  }

  // No HTTP status → transport-layer failure that never reached Twilio.
  // (A Twilio business-logic error always carries a numeric `.status`,
  // so reaching here means a socket/DNS failure.)
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
 * Default SMS send policy: 3 attempts (2 retries), ~200ms then ~400ms of
 * jittered backoff. Only ever paid when an attempt fails retryably; the
 * happy path adds zero latency.
 */
export const DEFAULT_SMS_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
};

export interface WithRetryHooks {
  shouldRetry: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: {
    attempt: number;
    nextDelayMs: number;
    err: unknown;
  }) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff: random in [0, min(cap, base*2^n)]. */
export function computeBackoffMs(attempt: number, policy: RetryPolicy): number {
  const exp = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exp);
  return Math.floor(Math.random() * capped);
}

/**
 * Run `fn`, retrying retryable errors per `policy` + `hooks`. Re-throws
 * the last error when attempts are exhausted or the error is terminal.
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
