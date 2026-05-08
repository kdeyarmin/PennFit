// Lightweight retry helper for external API calls.
//
// Why this exists
// ---------------
// Stripe, SendGrid, and Twilio all occasionally surface transient
// failures (TLS handshake races, brief 5xx, rate-limit blips) that
// succeed on the next attempt a fraction of a second later. Today
// the codebase mostly logs the error and keeps going, which means
// the call never gets a second chance — the user-facing flow that
// triggered it sees the failure even though a single retry would
// have made the failure invisible.
//
// Design choices
// --------------
//   * Exponential backoff with jitter so two retrying callers don't
//     dog-pile the same upstream at the same instant.
//   * Caller-supplied `isRetriable` predicate. We do NOT try to
//     classify errors generically — every SDK has its own error
//     shape, and a wrong guess turns a permanent 4xx into a retry
//     storm. Each call site declares which errors it considers
//     transient.
//   * `attempts` includes the initial try, so `attempts: 3` =
//     "try once, retry up to 2 more times" (matches every other
//     retry semantics anyone has worked with — "retries: 2" reads
//     ambiguously).
//   * The logger callback is OPTIONAL so the helper has no
//     dependency on any specific logger; tests pass undefined and
//     production passes `req.log` or the module logger.
//   * Aborting (e.g. via AbortSignal carried by the caller) is
//     intentionally NOT modeled here — every external SDK provides
//     its own cancellation primitive and the helper just propagates
//     whatever the underlying call throws.
//
// What this is NOT
// ----------------
// A circuit breaker. If the upstream is genuinely down, retries
// just increase the time the user waits before we surface the
// failure. A breaker would short-circuit further calls for some
// cooldown — a worthwhile follow-up but out of scope for this
// minimal helper.

export interface WithRetryOptions {
  /**
   * Maximum total attempts including the first call. `attempts: 3`
   * means "call once, retry up to 2 more times". Must be >= 1.
   */
  attempts?: number;
  /**
   * Base delay before the first retry, in milliseconds. The actual
   * delay for retry N (1-indexed) is
   *   `baseDelayMs * 2^(N-1)` (capped at maxDelayMs)
   * plus jitter in [0, baseDelayMs].
   */
  baseDelayMs?: number;
  /** Cap on the post-backoff sleep (excluding jitter). */
  maxDelayMs?: number;
  /**
   * Predicate that decides whether a thrown error should trigger a
   * retry. Returning `false` re-throws immediately. Defaults to
   * "always retry" — but every production caller should override
   * this so a permanent 4xx isn't replayed.
   */
  isRetriable?: (err: unknown) => boolean;
  /**
   * Optional structured logger called once per retry. Receives the
   * attempt number that just FAILED (1-indexed) and the error so
   * call sites can wire it up to their pino instance.
   */
  onRetry?: (attempt: number, err: unknown, nextDelayMs: number) => void;
  /**
   * Sleep injection for tests. Defaults to `setTimeout`-based
   * promise. Tests can pass `() => Promise.resolve()` to remove
   * real wall-clock waits.
   */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTS: Required<
  Pick<WithRetryOptions, "attempts" | "baseDelayMs" | "maxDelayMs">
> = {
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` up to `attempts` times, retrying on transient errors
 * with exponential backoff + jitter.
 *
 * Throws the LAST error if every attempt fails (or the first
 * non-retriable error if `isRetriable` returns false).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_OPTS.attempts);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_OPTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_OPTS.maxDelayMs;
  const isRetriable = opts.isRetriable ?? (() => true);
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetriable(err)) {
        throw err;
      }
      const backoff = Math.min(
        baseDelayMs * 2 ** (attempt - 1),
        maxDelayMs,
      );
      const jitter = Math.floor(Math.random() * baseDelayMs);
      const nextDelay = backoff + jitter;
      opts.onRetry?.(attempt, err, nextDelay);
      await sleep(nextDelay);
    }
  }
  // Unreachable — every loop iteration either returns or throws —
  // but TypeScript's flow analysis can't prove it.
  throw lastError;
}
