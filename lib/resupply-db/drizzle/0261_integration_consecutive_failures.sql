-- Track consecutive SFTP list failures on clearinghouse_credentials so the
-- Office Ally inbound-poll job can detect sustained vendor outages and
-- alert ops after N consecutive failures, rather than silently skipping.
--
-- Also adds a lightweight tracker for the therapy nightly sync so
-- a sustained period of all-patients-failing is distinguishable from a
-- transient spike.

ALTER TABLE "resupply"."clearinghouse_credentials"
  ADD COLUMN IF NOT EXISTS "consecutive_list_failures" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "resupply"."integration_run_health" (
  "key"                    varchar(80) PRIMARY KEY,
  "consecutive_failures"   integer NOT NULL DEFAULT 0,
  "last_failure_at"        timestamptz,
  "last_failure_detail"    text,
  "last_success_at"        timestamptz,
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);
