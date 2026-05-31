-- 0194_metrics_substrate — Phase 0 / F2: metrics snapshot + threshold-
-- alert substrate.
-- (Renumbered from 0187 → 0194: main landed 0187_fhir_jwt_jti_replay_store
--  while this branch was open, so the original prefix collided.)
--
-- Why this exists
-- ---------------
-- The Owner cluster's push features (KPI threshold alerting, the weekly
-- digest, goal pace-to-target — see docs/feature-roadmap-2026-05-31.md
-- F2) all need two things the platform doesn't have yet:
--   1. a daily PERSISTED rollup of headline KPIs to diff against (the
--      analytics endpoints compute these live, but nothing stores a
--      time series), and
--   2. a generic THRESHOLD + ALERT pair so "denial rate jumped 5pts
--      week-over-week" can fire without a per-metric code change.
--
-- This migration lays the three tables. A nightly worker job populates
-- metrics_daily, and an evaluator job walks metric_thresholds against it
-- and writes metric_alerts (both land in follow-up slices). Nothing
-- reads these yet, so this is additive.
--
-- Design notes
-- ------------
--   * metrics_daily is KEYED (date, metric_key), not a wide column-per-
--     KPI table, so a new KPI is a new row not a migration — and the
--     threshold evaluator stays generic.
--   * Values are `double precision` (returned as JS numbers by PostgREST)
--     rather than `numeric` (returned as strings). This is a reporting /
--     alerting snapshot, NOT the accounting source of truth, so float is
--     the right trade for ergonomics. `unit` tells the UI how to render.
--   * These tables derive from EVENT tables + existing analytics queries,
--     never from audit_log (retired) — see CLAUDE.md hard rules.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- metrics_daily — one row per (day, KPI).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."metrics_daily" (
  "metric_date" date NOT NULL,
  -- e.g. 'revenue_net_cents', 'denial_rate_pct', 'active_subscriptions'.
  "metric_key" text NOT NULL,
  -- JS number via PostgREST (double, not numeric). Cents fit exactly
  -- below 2^53; ratios/percentages are fine.
  "metric_value" double precision NOT NULL,
  -- How to read metric_value: 'count' | 'cents' | 'ratio' | 'pct' |
  -- 'days'. Drives display + the threshold message wording.
  "unit" text NOT NULL DEFAULT 'count',
  -- Optional breakdown (e.g. per-payer denial counts) for drill-down.
  "metadata" jsonb,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("metric_date", "metric_key")
);
--> statement-breakpoint

ALTER TABLE "resupply"."metrics_daily"
  DROP CONSTRAINT IF EXISTS "metrics_daily_unit_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."metrics_daily"
  ADD CONSTRAINT "metrics_daily_unit_enum"
  CHECK ("unit" IN ('count', 'cents', 'ratio', 'pct', 'days'));
--> statement-breakpoint

-- Trend / week-over-week lookups walk one metric_key back in time.
CREATE INDEX IF NOT EXISTS "metrics_daily_key_date_idx"
  ON "resupply"."metrics_daily" ("metric_key", "metric_date" DESC);
--> statement-breakpoint

ALTER TABLE "resupply"."metrics_daily" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- metric_thresholds — generic alert rules over metrics_daily.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."metric_thresholds" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "metric_key" text NOT NULL,
  -- gt | gte | lt | lte — how `compared_value` relates to threshold.
  "comparison" text NOT NULL,
  "threshold_value" double precision NOT NULL,
  -- absolute      → compare today's value directly
  -- delta_7d      → compare (today − 7d-ago) in raw units
  -- delta_pct_7d  → compare the % change vs 7d-ago
  "mode" text NOT NULL DEFAULT 'absolute',
  "severity" text NOT NULL DEFAULT 'warning',
  "enabled" boolean NOT NULL DEFAULT true,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "resupply"."metric_thresholds"
  DROP CONSTRAINT IF EXISTS "metric_thresholds_comparison_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."metric_thresholds"
  ADD CONSTRAINT "metric_thresholds_comparison_enum"
  CHECK ("comparison" IN ('gt', 'gte', 'lt', 'lte'));
--> statement-breakpoint
ALTER TABLE "resupply"."metric_thresholds"
  DROP CONSTRAINT IF EXISTS "metric_thresholds_mode_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."metric_thresholds"
  ADD CONSTRAINT "metric_thresholds_mode_enum"
  CHECK ("mode" IN ('absolute', 'delta_7d', 'delta_pct_7d'));
--> statement-breakpoint
ALTER TABLE "resupply"."metric_thresholds"
  DROP CONSTRAINT IF EXISTS "metric_thresholds_severity_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."metric_thresholds"
  ADD CONSTRAINT "metric_thresholds_severity_enum"
  CHECK ("severity" IN ('info', 'warning', 'critical'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "metric_thresholds_enabled_idx"
  ON "resupply"."metric_thresholds" ("metric_key")
  WHERE "enabled" = true;
--> statement-breakpoint

ALTER TABLE "resupply"."metric_thresholds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- metric_alerts — a fired threshold breach.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."metric_alerts" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "threshold_id" text
    REFERENCES "resupply"."metric_thresholds"("id") ON DELETE CASCADE,
  "metric_key" text NOT NULL,
  "metric_date" date NOT NULL,
  "observed_value" double precision NOT NULL,
  -- The value actually compared to the threshold (the delta / pct-delta
  -- under a delta mode; equals observed_value under absolute).
  "compared_value" double precision,
  -- The 7-days-ago baseline when a delta mode drove the alert.
  "baseline_value" double precision,
  "severity" text NOT NULL,
  "message" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  -- When the email push went out (null until the notifier sends it).
  "notified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- One alert per threshold per day — makes the evaluator idempotent
  -- (ON CONFLICT DO NOTHING on a re-run within the same day).
  CONSTRAINT "metric_alerts_threshold_date_unique"
    UNIQUE ("threshold_id", "metric_date")
);
--> statement-breakpoint

ALTER TABLE "resupply"."metric_alerts"
  DROP CONSTRAINT IF EXISTS "metric_alerts_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."metric_alerts"
  ADD CONSTRAINT "metric_alerts_status_enum"
  CHECK ("status" IN ('open', 'acknowledged', 'resolved'));
--> statement-breakpoint

-- The alert feed lists open alerts newest-first.
CREATE INDEX IF NOT EXISTS "metric_alerts_status_created_idx"
  ON "resupply"."metric_alerts" ("status", "created_at" DESC);
--> statement-breakpoint

ALTER TABLE "resupply"."metric_alerts" ENABLE ROW LEVEL SECURITY;
