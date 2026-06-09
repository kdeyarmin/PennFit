// Lightweight per-vendor circuit breaker for the synchronous LLM call
// paths (the public chatbot gateway today; more callers can opt in).
//
// Why this exists
// ---------------
// `withRetry` / `sendWithRetry` absorb a transient blip — but during a
// SUSTAINED upstream outage, retries are actively harmful: every request
// waits out the full backoff before degrading, multiplying user-visible
// latency and tying up the single Node event loop under load. A breaker
// short-circuits: once a vendor has failed N times in a row it "opens"
// and the next requests skip the upstream entirely (instant degraded
// reply) for a cooldown, then a single trial request probes recovery.
//
// Design
// ------
//   * Per-vendor state (one breaker per `getLlmBreaker(vendor)` key),
//     module-level — correct for the single-instance API (see the
//     rate-limit note in middlewares/rate-limit.ts; the same
//     single-instance caveat applies).
//   * Three states: closed (normal), open (short-circuit), half-open
//     (one trial allowed). `canAttempt()` is the gate the caller checks
//     before calling the upstream; `recordSuccess()` / `recordFailure()`
//     report the outcome.
//   * Fail-OPEN by construction: when in doubt the breaker allows the
//     call (a half-open trial, or closed). A bug here degrades to "no
//     breaker", never "all calls blocked".
//   * `now` is injectable so tests don't depend on wall-clock.

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker from closed → open. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a half-open trial. */
  cooldownMs?: number;
  /** Clock seam for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half-open";

const DEFAULTS: Required<Omit<CircuitBreakerOptions, "now">> = {
  // 5 consecutive failures is well clear of incidental blips (which the
  // retry layer already absorbs) but trips quickly on a real outage.
  failureThreshold: 5,
  // 30s open window: long enough to stop hammering a downed vendor,
  // short enough that recovery is noticed promptly.
  cooldownMs: 30_000,
};

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  /** Timestamp the breaker opened, or null while closed. */
  private openedAt: number | null = null;
  /** True once a half-open trial is in flight (only one allowed). */
  private trialInFlight = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.now = opts.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.openedAt === null) return "closed";
    if (this.now() - this.openedAt >= this.cooldownMs) return "half-open";
    return "open";
  }

  /**
   * Should the caller attempt the upstream call right now? Returns false
   * only while the breaker is open AND a half-open trial hasn't been
   * handed out yet for this cooldown window. The first caller after the
   * cooldown elapses gets the single trial; concurrent callers in that
   * instant are short-circuited until the trial resolves.
   */
  canAttempt(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;
    // half-open: allow exactly one trial through.
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  recordFailure(): void {
    this.trialInFlight = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      // (Re-)open the breaker and restart the cooldown clock. A failed
      // half-open trial lands here and re-opens for another cooldown.
      this.openedAt = this.now();
    }
  }

  /** Test/diagnostic seam. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }
}

const breakers = new Map<string, CircuitBreaker>();

/**
 * Get (or lazily create) the shared breaker for a vendor key, e.g.
 * "openai" / "anthropic". One instance per key for the process.
 */
export function getLlmBreaker(
  vendor: string,
  opts?: CircuitBreakerOptions,
): CircuitBreaker {
  let b = breakers.get(vendor);
  if (!b) {
    b = new CircuitBreaker(opts);
    breakers.set(vendor, b);
  }
  return b;
}

/** Test seam — drop all breaker state between cases. */
export function __resetLlmBreakersForTests(): void {
  breakers.clear();
}
