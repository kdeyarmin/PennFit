-- audit_log.archived_at — flag rows past the HIPAA 6-year floor.
-- A nightly worker stamps the flag; destruction is human-triggered.

ALTER TABLE "resupply"."audit_log"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "audit_log_archive_sweep_idx"
  ON "resupply"."audit_log" ("occurred_at")
  WHERE archived_at IS NULL;
