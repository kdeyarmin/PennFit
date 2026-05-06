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
 * Decide whether a sign-in attempt is allowed right now. The check
 * fails OPEN on a DB error: we'd rather let one extra attempt
 * through than silently lock everyone out if the rate-limit table
 * is briefly unreadable. The handler still records the attempt
 * regardless of the decision, so the next call sees the latest
 * state.
 */
export async function checkLoginRateLimit(
  repo: AuthRepository,
  input: { emailLower: string; ip: string | null },
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
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
    // Fail open so a DB hiccup does not lock all users out. Log so
    // operators can detect a pattern (sustained degradation = real risk).
    console.error(
      "[resupply-auth] rate-limit check failed (fail-open):",
      err instanceof Error ? err.message : String(err),
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
