-- migrate: no-transaction
--
-- Indexes for two hot billing-director queries that currently lack
-- supporting indexes (audit: docs/backend-dme-efficiency-audit-2026-06-02.md
-- §2.3). `insurance_claims` already carries 11 indexes, but none on
-- `decision_at` or `submitted_at`, so these reads degrade to range
-- scans that worsen linearly with claim volume.
--
-- Built CONCURRENTLY (hence `-- migrate: no-transaction` above — the
-- migrator runs the statements outside the wrapping BEGIN/COMMIT, and
-- CONCURRENTLY cannot run inside a transaction block) so adding them to
-- a populated production table does not take a long ACCESS EXCLUSIVE
-- lock on the claims table. IF NOT EXISTS keeps the migration
-- idempotent on replay.

-- Decision-dated reads, both in src/routes/admin/billing-director.ts:
--   * `.eq("status","denied").gte("decision_at", t14d)`   (fresh denials)
--   * `.in("status", [...terminal]).gte("decision_at", t90d)` (90-day trend)
-- A (status, decision_at DESC) composite serves the status-equality
-- denial read as a single range scan and the terminal-status IN read as
-- a handful of merged per-status range scans. Partial on
-- decision_at IS NOT NULL so undecided claims stay out of the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "insurance_claims_status_decision_at_idx"
  ON "resupply"."insurance_claims" ("status", "decision_at" DESC)
  WHERE "decision_at" IS NOT NULL;
--> statement-breakpoint

-- "Stuck submitted" read (billing-director.ts):
--   `.eq("status","submitted").lte("submitted_at", t48h)`
-- A tiny partial index keyed on submitted_at, scoped to the only status
-- the query ever asks for, so it stays small and selective.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "insurance_claims_submitted_at_idx"
  ON "resupply"."insurance_claims" ("submitted_at")
  WHERE "status" = 'submitted';
