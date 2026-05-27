-- worker_dedup_keys — best-effort idempotency for in-process workers.
--
-- Solves the "pg-boss retry double-sends" problem: a worker job that
-- succeeds at the vendor call (Twilio accepts the SMS) but then fails
-- on a downstream DB write gets re-run by pg-boss, and re-fires the
-- vendor call. Vendors don't deduplicate on our behalf — Twilio happily
-- accepts and bills for the same SMS twice if we ask twice.
--
-- Worker handlers `INSERT … ON CONFLICT DO NOTHING` a deterministic key
-- BEFORE the vendor call. If the insert reports a conflict, the prior
-- attempt already won and we short-circuit. The vendor call then runs
-- under the protection of the lock — even if it succeeds and the
-- post-vendor DB writes crash, pg-boss's retry hits the conflict and
-- exits silently.
--
-- This is NOT the right table for HTTP request idempotency — that's
-- `idempotency_keys`, which carries the response body so a replay
-- returns byte-identical JSON. `worker_dedup_keys` is leaner because
-- workers don't have a caller to mirror a response to: the boolean
-- "did this key win the race?" is the entire contract.
--
-- expires_at is required at insert time; consumers choose the TTL
-- appropriate to their workload (24h for reminders is the canonical
-- example — the same patient/episode shouldn't fire two reminders in
-- the same day regardless of retry count). A separate sweeper job
-- prunes expired rows; this migration only declares the table.
CREATE TABLE IF NOT EXISTS "resupply"."worker_dedup_keys" (
  "key" text PRIMARY KEY,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "worker_dedup_keys_expires_at_idx"
  ON "resupply"."worker_dedup_keys" ("expires_at");
