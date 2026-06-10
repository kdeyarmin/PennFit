-- Persistent consecutive-failure tracker for integration crons so jobs can
-- detect sustained vendor outages and alert ops after N consecutive failures.
--
-- Used by:
--   - Office Ally inbound-poll (SFTP list failures)
--   - Therapy nightly sync (high failure-rate runs)

CREATE TABLE IF NOT EXISTS "resupply"."integration_run_health" (
  "key"                    varchar(80) PRIMARY KEY,
  "consecutive_failures"   integer NOT NULL DEFAULT 0,
  "last_failure_at"        timestamptz,
  "last_failure_detail"    text,
  "last_success_at"        timestamptz,
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);
