// Session expiry math.
//
// Sliding window: every authenticated request bumps the session
// forward by `ttlDays`, bounded by `absoluteMaxDays`. The absolute
// cap means a stolen-and-actively-used cookie still expires within
// a known window even if the attacker keeps it warm.

export interface SessionExpiryConfig {
  /** Default 14 days. */
  ttlDays: number;
  /** Hard ceiling regardless of activity. Default 90 days. */
  absoluteMaxDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SessionWindow {
  issuedAt: Date;
  expiresAt: Date;
}

/** Brand-new session issued `now`. */
export function issueWindow(
  now: Date,
  config: SessionExpiryConfig,
): SessionWindow {
  const expires = new Date(now.getTime() + config.ttlDays * MS_PER_DAY);
  return { issuedAt: new Date(now), expiresAt: expires };
}

/**
 * Slide a session forward by ttlDays from `now`, capped by
 * `issuedAt + absoluteMaxDays`. Returns the new expiresAt — the
 * caller writes it back to the row.
 *
 * Returning the original expiresAt unchanged when we'd overshoot
 * the absolute cap is intentional: we want the session to keep
 * working until it actually expires, but we never extend past the
 * cap.
 */
export function slideExpiry(
  current: SessionWindow,
  now: Date,
  config: SessionExpiryConfig,
): Date {
  const ttl = config.ttlDays * MS_PER_DAY;
  const cap = (config.absoluteMaxDays ?? 90) * MS_PER_DAY;
  const proposed = now.getTime() + ttl;
  const ceiling = current.issuedAt.getTime() + cap;
  const next = Math.min(proposed, ceiling);
  // Never move expiry backward; if `now + ttl` < current.expiresAt
  // (system clock skew, tests), keep the current one.
  return new Date(Math.max(next, current.expiresAt.getTime()));
}

/**
 * True when the session is past its expiry OR has been revoked.
 * `revokedAt` is the explicit sign-out / password-change marker.
 */
export function isExpired(
  session: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): boolean {
  if (session.revokedAt) {
    return true;
  }
  return session.expiresAt.getTime() <= now.getTime();
}
