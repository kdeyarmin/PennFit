-- 0332 — daily trend of open clinical-signal volume.
--
-- The Clinical Insights report shows the clinical smart-trigger queue
-- right now; the therapy-fleet daily snapshot already trends the
-- compliance/at-risk/leak cohorts over time. This adds the missing
-- layer: how many CLINICAL signals (pressure pegging, AHI elevated/
-- rising, non-adherence, erratic use) are open day over day — so a DME
-- can see whether the clinical burden is climbing or the interventions
-- are working.
--
-- Two pieces:
--   1. Three additive count columns on therapy_fleet_daily_metrics
--      (open total + high/medium severity split). Additive, default 0,
--      no backfill — historical rows simply read 0 until the snapshot
--      worker fills them going forward.
--   2. therapy_clinical_signal_counts() — a tiny aggregate RPC the
--      daily-snapshot worker calls (it can't GROUP BY via PostgREST).
--      Counts active (undismissed) clinical events and splits them by
--      severity. The kind→severity split is kept in lockstep with
--      lib/smart-triggers/index.ts PATIENT_DISPATCH_KINDS and the
--      Clinical Insights route's SEVERITY map.
--
-- PHI / log posture: pure aggregate counts, no patient identifiers —
-- same posture as the rest of therapy_fleet_daily_metrics.
--
-- Journal posture (per CLAUDE.md): NOT added to meta/_journal.json;
-- migrate.mjs dedups by file hash and runs each SQL once. Additive +
-- IF NOT EXISTS / CREATE OR REPLACE, so a re-run / forward-deploy is a
-- no-op.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."therapy_fleet_daily_metrics"
  ADD COLUMN IF NOT EXISTS "clinical_signals_open" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "resupply"."therapy_fleet_daily_metrics"
  ADD COLUMN IF NOT EXISTS "clinical_signals_high" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "resupply"."therapy_fleet_daily_metrics"
  ADD COLUMN IF NOT EXISTS "clinical_signals_medium" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Ensure the `service_role` role exists before the GRANT (vanilla
-- Postgres in CI from-scratch replays has no such role).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.therapy_clinical_signal_counts()
RETURNS TABLE(
  total bigint,
  high bigint,
  medium bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    COUNT(*)::bigint AS total,
    COUNT(*) FILTER (
      WHERE kind IN ('pressure_at_max', 'ahi_elevated', 'non_adherent_30d')
    )::bigint AS high,
    COUNT(*) FILTER (
      WHERE kind IN ('ahi_rising', 'usage_erratic')
    )::bigint AS medium
  FROM resupply.patient_smart_trigger_events
  WHERE dismissed_at IS NULL
    AND kind IN (
      'pressure_at_max',
      'ahi_elevated',
      'non_adherent_30d',
      'ahi_rising',
      'usage_erratic'
    )
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.therapy_clinical_signal_counts()
  TO service_role;
