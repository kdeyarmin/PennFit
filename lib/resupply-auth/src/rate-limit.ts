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
  reason?: "email_locked" | "ip_locked";
  /** Recommended Retry-After (seconds) when blocked. */
  retryAfterSeconds: number;
}

/**
 * Observability hook invoked when the rate-limit check throws and
 * we fall back to fail-open. Callers should plumb this to their
 * structured logger AND emit a metric so a sustained DB issue
 * (which silently disables rate limiting and creates a brute-force
 * window) is visible to ops. Default = `console.error`.
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
    "[resupply-auth] rate-limit check failed (fail-open):",
    err instanceof Error ? err.message : String(err),
  );
};

/**
 * Determine whether a sign-in attempt should be allowed immediately under the configured rate limits.
 *
 * Evaluates separate rolling-window failure counts for the provided email (case-normalized) and IP, and applies the stricter limit. On database or other errors the check fails open (permits the attempt) and invokes `onError` so observability can record the failure; failures in `onError` are swallowed and do not change the fail-open behavior.
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
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
