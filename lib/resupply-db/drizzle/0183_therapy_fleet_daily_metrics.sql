-- 0183 — daily fleet-metrics snapshot table (Therapy Fleet phase 6).
--
-- The Phase 1–4 fleet surfaces are all point-in-time: they answer "where
-- does the fleet stand right now?" but not "is it getting better or
-- worse?". A DME running interventions (compliance outreach, re-fits,
-- resupply pushes) needs the week-over-week trend to know whether the
-- work is moving the numbers.
--
-- A nightly worker job (therapy-fleet.daily-snapshot) calls the existing
-- summary RPCs (therapy_fleet_overview / therapy_resupply_summary /
-- therapy_setup_adherence_summary) and upserts one row per day here. The
-- /admin/therapy-fleet/trend route reads the history; the fleet page
-- renders sparklines from it. One row per calendar date (upsert on
-- metric_date) keeps the table tiny and idempotent across re-runs.
--
-- PHI / log posture: aggregate counts only — no patient identifiers,
-- no usage/AHI/leak values. Reachable only via the service-role client.
-- RLS enabled deny-all to match the 0169/0170 posture.

CREATE TABLE IF NOT EXISTS "resupply"."therapy_fleet_daily_metrics" (
  "metric_date" date PRIMARY KEY,
  "patients_with_data" integer NOT NULL DEFAULT 0,
  "compliant" integer NOT NULL DEFAULT 0,
  "at_risk" integer NOT NULL DEFAULT 0,
  "non_compliant" integer NOT NULL DEFAULT 0,
  "high_leak" integer NOT NULL DEFAULT 0,
  "resupply_items_due" integer NOT NULL DEFAULT 0,
  "setups_in_window" integer NOT NULL DEFAULT 0,
  "setups_at_risk" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- RLS — match the deny-all posture established in 0169/0170.
-- service_role (the only runtime data path) bypasses RLS; enabling it
-- with no policy makes the table deny-all to anon/authenticated. 0170's
-- catalog loop already ran, so a new table must enable it here.
ALTER TABLE "resupply"."therapy_fleet_daily_metrics" ENABLE ROW LEVEL SECURITY;
