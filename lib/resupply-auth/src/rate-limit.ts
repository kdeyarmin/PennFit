// DB-backed login-attempt rate limiter.
//
// Counts rows in `auth.login_attempts` over a rolling window. We
// use the DB (instead of an in-process Map) so:
//   * Multiple API instances see the same counter — important
//     once we run more than one process.
//   * The counter survives restarts; an attacker can't reset it
//     by knocking the API offline.
//   * It piggybacks on the same audit-grade table that supports
//     post-incident "did anyone get in?" investigations, so we
//     don't carry a parallel tally.
//
// Two buckets: per-email and per-IP. They're checked separately
// and the stricter limit wins. The per-email check is the
// load-bearing one for credential-stuffing (an attacker tries one
// email from many IPs); the per-IP check is the load-bearing one
// for spray (one IP tries many emails).

import type { AuthRepository } from "./repository";

export interface RateLimitConfig {
  /** Allowed failures per email per `windowMs`. Default 5. */
  maxPerEmail: number;
  /** Allowed failures per IP per `windowMs`. Default 30. */
  maxPerIp: number;
  /** Window length in milliseconds. Default 15 minutes. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxPerEmail: 5,
  maxPerIp: 30,
  windowMs: 15 * 60 * 1000,
};

export interface RateLimitDecision {
  allowed: boolean;
  reason?: "email_locked" | "ip_locked" | "check_failed";
  /** Recommended Retry-After (seconds) when blocked. */
  retryAfterSeconds: number;
}

/**
 * Retry-After when the check itself fails (fail-closed). Short on
 * purpose: the trigger is a transient DB error, not an attacker
 * hitting a limit, so the caller should be invited back quickly —
 * if the DB is still down on retry, sign-in would fail at the
 * user-lookup step anyway.
 */
export const CHECK_FAILED_RETRY_AFTER_SECONDS = 30;

/**
 * Observability hook invoked when the rate-limit check throws and
 * the gate fails closed. Callers should plumb this to their
 * structured logger AND emit a metric so a sustained DB issue
 * (which is now blocking sign-ins with 429s rather than silently
 * disabling rate limiting) is visible to ops. Default =
 * `console.error`.
 *
 * The return type is `void | Promise<void>` so async loggers (e.g.
 * a backend that fires-and-forgets a network log shipper) can be
 * passed directly. `checkLoginRateLimit` awaits the result inside
 * its own try/catch so a rejected Promise never escapes past the
 * gate.
 */
export type RateLimitErrorHandler = (
  err: unknown,
  context: { emailLower: string; ip: string | null },
) => void | Promise<void>;

const defaultErrorHandler: RateLimitErrorHandler = (err) => {
  // Bare console fallback so a missing handler never crashes auth.
  // Production callers should override this with a structured
  // logger + a metric (e.g. `auth.rate_limit.check_failed`).
  console.error(
    "[resupply-auth] rate-limit check failed (fail-closed):",
    err instanceof Error ? err.message : String(err),
  );
};

/**
 * Determine whether a sign-in attempt should be allowed immediately under the configured rate limits.
 *
 * Evaluates separate rolling-window failure counts for the provided email (case-normalized) and IP, and applies the stricter limit. On database or other errors the check fails CLOSED (denies the attempt with reason `"check_failed"` and a short Retry-After) and invokes `onError` so observability can record the failure; failures in `onError` are swallowed and do not change the fail-closed behavior.
 *
 * Fail-closed rationale (app-review 2026-06-10, P2-18): failing open
 * meant a DB blip silently disabled brute-force protection exactly
 * when the only backstop was the per-IP edge limiter (itself
 * weakened behind Cloudflare, P1-5). Failing closed costs little
 * availability — if `countRecentFailures` can't reach the DB, the
 * subsequent credential lookup on the same repo would fail anyway —
 * and removes the brute-force window.
 *
 * @param input - Context for the attempt. `emailLower` is the lowercased email identifier; `ip` is the client IP or `null` when unavailable.
 * @param config - Rate-limit parameters (`maxPerEmail`, `maxPerIp`, `windowMs`). Defaults are used when omitted.
 * @param onError - Optional callback invoked with the caught error and `input` when the check cannot complete due to an exception.
 * @returns A RateLimitDecision: `allowed` indicates if the attempt is permitted; when blocked the `reason` is `"email_locked"` or `"ip_locked"` and `retryAfterSeconds` suggests how many seconds to wait before retrying.
 */
export async function checkLoginRateLimit(
  repo: AuthRepository,
  input: { emailLower: string; ip: string | null },
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
  onError: RateLimitErrorHandler = defaultErrorHandler,
): Promise<RateLimitDecision> {
  try {
    const [emailFails, ipFails] = await Promise.all([
      repo.countRecentFailures({
        emailLower: input.emailLower,
        ip: null,
        sinceMs: config.windowMs,
      }),
      input.ip
        ? repo.countRecentFailures({
            emailLower: null,
            ip: input.ip,
            sinceMs: config.windowMs,
          })
        : Promise.resolve(0),
    ]);

    if (emailFails >= config.maxPerEmail) {
      return {
        allowed: false,
        reason: "email_locked",
        retryAfterSeconds: Math.ceil(config.windowMs / 1000),
      };
    }
    if (ipFails >= config.maxPerIp) {
      return {
        allowed: false,
        reason: "ip_locked",
        retryAfterSeconds: Math.ceil(config.windowMs / 1000),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (err) {
    try {
      // Await so an async handler's rejection lands in this catch
      // rather than escaping as an unhandled-promise rejection.
      // Synchronous handlers `await undefined` cheaply.
      await onError(err, input);
    } catch {
      // Observability must never throw past the rate-limit gate.
    }
    return {
      allowed: false,
      reason: "check_failed",
      retryAfterSeconds: CHECK_FAILED_RETRY_AFTER_SECONDS,
    };
  }
}
