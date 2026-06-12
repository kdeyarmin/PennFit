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

/**
 * Brand-new session issued `now`. The TTL is clamped to
 * `absoluteMaxDays` so a misconfigured `ttlDays` larger than the cap
 * can't mint a first session that outlives the ceiling `slideExpiry`
 * enforces — without the clamp, only SLIDES were capped and the
 * initial window escaped it.
 */
export function issueWindow(
  now: Date,
  config: SessionExpiryConfig,
): SessionWindow {
  const ttlDays = Math.min(config.ttlDays, config.absoluteMaxDays ?? 90);
  const expires = new Date(now.getTime() + ttlDays * MS_PER_DAY);
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
  // (system clock skew, tests), keep the current one — BUT still clamp to
  // the absolute ceiling. Without the outer Math.min, a row whose
  // expiresAt already sits past the ceiling (e.g. written under a longer
  // prior absoluteMaxDays, or a manual/clock-skew edit) would be returned
  // uncapped, defeating the "stolen cookie expires within a known window"
  // guarantee in this file's header. In normal operation expiresAt is
  // always <= ceiling, so this Math.min is a no-op.
  return new Date(
    Math.min(Math.max(next, current.expiresAt.getTime()), ceiling),
  );
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
