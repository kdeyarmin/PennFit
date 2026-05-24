-- worker_run_summary — durable record of the last successful run of
-- each in-process worker job.
--
-- Background: the ops dashboard's "PHI attachment sweep — last run"
-- tile (artifacts/resupply-api/src/routes/dashboard/sweep-status.ts)
-- previously SELECTed from `resupply.audit_log` with
-- `action='prescription.attachment.sweep'`. Migration 0156 retired the
-- HIPAA tamper-evident audit chain, and `@workspace/resupply-audit`
-- became a no-op stub — every `logAudit({ … })` since then is a
-- silent no-op. The dashboard tile kept rendering whatever the last
-- pre-stub audit row was, which grew increasingly stale and gave
-- operators a false signal that the sweep was running fine.
--
-- This table is the durable replacement. The sweep worker writes one
-- row per run on completion (success or partial failure). The
-- dashboard reads the most recent row for the worker_kind it cares
-- about. Future worker jobs that need a similar liveness signal can
-- reuse this table by picking a distinct `worker_kind` string.
--
-- Schema notes:
--   * `worker_kind` is free-text rather than an enum so a new worker
--     can adopt the table without a schema migration. Convention:
--     dot-separated, lowercase, plural-aware
--     (e.g. 'prescription_attachment_sweep').
--   * `counters` is jsonb; each worker defines its own counter shape
--     and the reader Zod-validates on the way out.
--   * `started_at` and `completed_at` are separate so the reader can
--     compute duration. Defaults both to now() so a worker that only
--     calls insert() at the END of the run still gets a meaningful
--     row (started_at == completed_at).
--   * Retention is monotonic for now (no TTL pruning). The expected
--     write volume is ~1 row/hour per worker, so the table stays
--     small for years even without pruning. A dedicated prune job
--     can come later if/when retention becomes a concern.

CREATE TABLE IF NOT EXISTS "resupply"."worker_run_summary" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "worker_kind" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "counters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Composite index for the "latest row by worker_kind" query the
-- dashboard reader runs. DESC on completed_at so the LIMIT 1 lookup
-- is an index scan, not a sort.
CREATE INDEX IF NOT EXISTS "worker_run_summary_kind_completed_at_idx"
  ON "resupply"."worker_run_summary" ("worker_kind", "completed_at" DESC);
