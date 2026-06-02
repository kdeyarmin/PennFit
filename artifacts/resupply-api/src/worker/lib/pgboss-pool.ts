// Connection-pool sizing for the in-process pg-boss worker.
//
// pg-boss opens its OWN dedicated node-postgres pool — separate from
// PostgREST's pool (which every runtime query goes through) and from
// `getDbPool`'s legacy pg pool. On a Supabase instance with a modest
// `max_connections`, leaving this pool at pg-boss's larger built-in
// default is dangerous: multiplied across a deploy-rollover overlap
// (the draining old container and the new container are both connected
// for a few seconds) — or across more than one replica — it can consume
// every connection slot. Once that happens PostgREST starts returning
//   FATAL: remaining connection slots are reserved for roles with the
//          SUPERUSER attribute
// and every query 503s, which the admin sign-in path surfaces to the
// user as "We can't reach the credentials store right now." (See the
// 2026-06 incident: the worker's pg-boss pool, plus a leaked pool on
// each failed start, exhausted the database and locked admins out.)
//
// These are low-frequency, cron-style queues, so a small bounded pool
// is plenty. Tunable via the PGBOSS_POOL_MAX env var (mirrors the
// DB_POOL_MAX knob for the legacy pg pool) so ops can adjust it to the
// project's connection budget without a code change. Invalid, zero, or
// negative values fall back to the default.

export const DEFAULT_PGBOSS_POOL_MAX = 5;

/**
 * Resolve the pg-boss connection-pool `max` from a raw env value.
 *
 * @param raw - The raw `PGBOSS_POOL_MAX` value (or `undefined` when unset).
 * @param fallback - Value to use when `raw` is missing or invalid.
 * @returns A positive integer pool size.
 */
export function resolvePgBossPoolMax(
  raw: string | undefined,
  fallback: number = DEFAULT_PGBOSS_POOL_MAX,
): number {
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
