-- 0190_business_targets — Phase 1 (Owner #8): goal / target tracking.
--
-- Why this exists
-- ---------------
-- An owner wants to set a monthly (or quarterly) target for a headline
-- KPI — net collections, new patients, orders — and watch pace-to-goal.
-- This table holds the targets; the F2 metrics_daily series provides the
-- actuals, so a future "pace" view joins the two by metric_key. Keyed
-- (metric_key, period) so there is exactly one target per metric per
-- period and re-setting it is an idempotent upsert.
--
-- Additive, RLS deny-all (service-role only). Values are double precision
-- (JS numbers via PostgREST) to match metrics_daily. Per ADR 003.

CREATE TABLE IF NOT EXISTS "resupply"."business_targets" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  -- Matches a metrics_daily.metric_key (e.g. 'revenue_net_cents',
  -- 'orders_paid_count') so a pace view can join target ↔ actual.
  "metric_key" text NOT NULL,
  -- The target period, e.g. '2026-05' (month), '2026-Q2', or '2026'.
  "period" text NOT NULL,
  "target_value" double precision NOT NULL,
  "unit" text NOT NULL DEFAULT 'count',
  "notes" text,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_targets_metric_period_unique"
    UNIQUE ("metric_key", "period")
);
--> statement-breakpoint

ALTER TABLE "resupply"."business_targets"
  DROP CONSTRAINT IF EXISTS "business_targets_unit_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."business_targets"
  ADD CONSTRAINT "business_targets_unit_enum"
  CHECK ("unit" IN ('count', 'cents', 'ratio', 'pct', 'days'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "business_targets_period_idx"
  ON "resupply"."business_targets" ("period");
--> statement-breakpoint

ALTER TABLE "resupply"."business_targets" ENABLE ROW LEVEL SECURITY;
