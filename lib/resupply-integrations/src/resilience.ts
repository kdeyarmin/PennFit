// resilience.ts — bounded retries with jitter, and a circuit breaker, for
// therapy-cloud calls.
//
// TWO PROBLEMS, AND THEY PULL IN OPPOSITE DIRECTIONS
// --------------------------------------------------
// The nightly sync walks a thousand patient links. Without retries, one
// blip drops a patient's data for a day. With naive retries, a WRONG
// CLIENT SECRET becomes three thousand rejected auth attempts inside a
// few minutes, which is how an account gets locked out by the vendor —
// turning a five-minute fix into a support ticket and a day of no data.
//
// So the rules are asymmetric, and the asymmetry is the whole design:
//
//   * Only TRANSIENT failures are retried. A configuration failure — bad
//     credentials, a missing agreement, a wrong path, a schema drift — is
//     returned on the first attempt. Retrying it cannot help and can
//     actively harm.
//   * Retries are jittered. A thousand links failing in lockstep and
//     retrying at exactly 1s, 2s, 4s is a thundering herd aimed at a
//     vendor that is already struggling.
//   * A circuit breaker sits above the retries. After enough consecutive
//     unhealthy results the connector opens and stops calling entirely
//     for a cool-down. This is what actually stops the hammering: retries
//     bound ONE call, the breaker bounds the whole run.
//
// PURE: no clock of its own beyond `Date.now`, no logging, no I/O. The
// breaker's state is in-process and per (source, org), which is the right
// scope — a second tenant's credentials are not implicated by the first
// tenant's being wrong.

import { isRetryable, type AdapterError } from "./errors";

export interface RetryOptions {
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** Delay before the first retry. Doubles each time. */
  baseDelayMs?: number;
  /** Ceiling on any single delay. */
  maxDelayMs?: number;
  /** Injected for tests. Returns [0, 1). */
  random?: () => number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 15_000;

/**
 * Full-jitter exponential backoff: a delay drawn uniformly from
 * `[0, min(cap, base * 2^attempt))`.
 *
 * Full jitter rather than "exponential plus a bit of noise" because the
 * herd is the problem, not the average delay. Drawing from the whole
 * interval spreads a thousand simultaneous failures across the window
 * instead of clustering them at its end.
 *
 * @param attempt - Zero-based retry number.
 * @param options - Base delay, cap, and an injectable random source.
 * @returns Delay in milliseconds.
 */
export function backoffDelayMs(
  attempt: number,
  options: RetryOptions = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export interface RetryOutcome<T> {
  result: T;
  attempts: number;
  /** Total time spent sleeping between attempts. */
  waitedMs: number;
}

/**
 * Run an adapter call with bounded, jittered retries.
 *
 * The operation returns a discriminated result rather than throwing, so
 * this decides retryability from the CLASSIFIED error rather than from an
 * exception type it would have to guess at.
 *
 * @param operation - The call. Receives the zero-based attempt number.
 * @param options - Attempt count, delays, injectable clock and randomness.
 * @returns The final result plus how many attempts it took.
 */
export async function withRetries<
  T extends { ok: boolean; error?: AdapterError },
>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let waitedMs = 0;
  let last: T | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await operation(attempt);
    if (last.ok) return { result: last, attempts: attempt + 1, waitedMs };
    // A configuration failure is returned immediately. Retrying a bad
    // secret is how an account gets locked out.
    if (!last.error || !isRetryable(last.error)) {
      return { result: last, attempts: attempt + 1, waitedMs };
    }
    if (attempt === maxAttempts - 1) break;
    const delay = backoffDelayMs(attempt, options);
    waitedMs += delay;
    await sleep(delay);
  }

  return { result: last as T, attempts: maxAttempts, waitedMs };
}

// ── Circuit breaker ──────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  /** Consecutive unhealthy results before the circuit opens. */
  failureThreshold?: number;
  /** How long it stays open before allowing one probe. */
  cooldownMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

interface BreakerEntry {
  consecutiveFailures: number;
  openedAt: number | null;
  lastError: AdapterError | null;
}

/**
 * Per-key circuit breaker.
 *
 * Keyed by `(source, org)`: one tenant's wrong credentials must not stop
 * calls for a tenant whose credentials are fine.
 *
 * A `no_data` result is NOT a failure. A vendor that legitimately has
 * nothing for five patients in a row must not trip the breaker — that
 * would turn an empty roster into an outage.
 */
export class IntegrationCircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  private entry(key: string): BreakerEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { consecutiveFailures: 0, openedAt: null, lastError: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Current state, resolving an elapsed cool-down into `half_open`. */
  state(key: string): BreakerState {
    const e = this.entry(key);
    if (e.openedAt === null) return "closed";
    return this.now() - e.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /**
   * May a call proceed?
   *
   * `half_open` allows exactly one probe: if it succeeds the breaker
   * closes, and if it fails the cool-down restarts. That is what makes a
   * recovered vendor come back without a deploy.
   */
  canAttempt(key: string): boolean {
    return this.state(key) !== "open";
  }

  /** Why the breaker is open, for an operator-facing status. */
  lastError(key: string): AdapterError | null {
    return this.entry(key).lastError;
  }

  /** Milliseconds until a probe is allowed. Zero when one is allowed now. */
  retryAfterMs(key: string): number {
    const e = this.entry(key);
    if (e.openedAt === null) return 0;
    return Math.max(0, e.openedAt + this.cooldownMs - this.now());
  }

  /** Record a healthy call. Closes the breaker. */
  recordSuccess(key: string): void {
    const e = this.entry(key);
    e.consecutiveFailures = 0;
    e.openedAt = null;
    e.lastError = null;
  }

  /**
   * Record a failure. Opens the breaker at the threshold.
   *
   * @param key - `(source, org)` key.
   * @param error - The classified failure.
   */
  recordFailure(key: string, error: AdapterError): void {
    const e = this.entry(key);
    e.lastError = error;
    e.consecutiveFailures += 1;
    if (e.consecutiveFailures >= this.failureThreshold) {
      e.openedAt = this.now();
    }
  }

  /**
   * Record a `no_data` answer — a success for breaker purposes. A vendor
   * that legitimately has nothing must not look like an outage.
   */
  recordNoData(key: string): void {
    this.recordSuccess(key);
  }

  /** Forget everything. For tests and for an operator-forced retry. */
  reset(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}

/** The key shape used everywhere. */
export function breakerKey(source: string, orgId: string): string {
  return `${source}:${orgId}`;
}
