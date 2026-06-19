-- 0380_metrics_substrate_org_scoped — multi-tenant: scope the F2 metrics
-- substrate (metrics_daily / metric_thresholds / metric_alerts) per tenant.
--
-- WHY (deferred analytics-grain redesign — see
-- docs/multi-tenant-analytics-grain-redesign-plan.md)
--   The metrics trio (migration 0194) is grain-keyed on non-tenant
--   dimensions: metrics_daily PK (metric_date, metric_key); thresholds /
--   alerts keyed by id. 0342 deferred them because per-tenant scoping is a
--   PK/grain REDESIGN, not an additive column. This is that redesign for the
--   three metrics tables: each tenant gets its OWN daily snapshot, its OWN
--   threshold rules, and its OWN fired alerts, so one tenant's revenue dip
--   can never fire on another tenant's metric, and a tenant admin's
--   thresholds/alerts views show only that tenant's rows.
--
-- WHAT
--   * metrics_daily — add org_id (nullable → backfill seed → NOT NULL),
--     re-key PRIMARY KEY (metric_date, metric_key) -> (org_id, metric_date,
--     metric_key), and re-create the trend index with org_id leading.
--   * metric_thresholds — add org_id (same backfill), re-create the
--     enabled-lookup index with org_id leading. PK stays `id`.
--   * metric_alerts — add org_id (backfill from the parent threshold's org,
--     else seed), index it. PK stays `id`; the (threshold_id, metric_date)
--     idempotency unique stays (threshold_id already implies the org).
--   * ENABLE RLS + the org_isolation policy on all three (mirrors 0348/0361).
--     service_role (the runtime path) bypasses RLS — runtime-inert today,
--     defense-in-depth backstop.
--
-- The runtime cutover (snapshot + evaluator fan out per tenant; the three
-- admin routes drop `.raw()` for the org-scoped facade; owner-digest sums
-- across tenants to stay a platform digest; the metrics_daily_latest RPC
-- takes p_org_id) ships in the same PR. Single-tenant behavior is unchanged:
-- the seed tenant's rows are the ones read/written today, and a freshly
-- onboarded tenant simply starts an empty series.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── metrics_daily ──
ALTER TABLE "resupply"."metrics_daily"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."metrics_daily"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."metrics_daily"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
-- Re-key: one snapshot row per tenant per (date, metric_key).
ALTER TABLE "resupply"."metrics_daily"
  DROP CONSTRAINT IF EXISTS "metrics_daily_pkey";
--> statement-breakpoint
ALTER TABLE "resupply"."metrics_daily"
  ADD CONSTRAINT "metrics_daily_pkey"
  PRIMARY KEY ("org_id", "metric_date", "metric_key");
--> statement-breakpoint
-- Trend / week-over-week lookups now walk one tenant's one metric_key back
-- in time. Replace the global (metric_key, metric_date DESC) index.
DROP INDEX IF EXISTS "resupply"."metrics_daily_metric_key_date_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metrics_daily_org_key_date_idx"
  ON "resupply"."metrics_daily" ("org_id", "metric_key", "metric_date" DESC);
--> statement-breakpoint
ALTER TABLE "resupply"."metrics_daily" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."metrics_daily";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."metrics_daily"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- ── metric_thresholds ──
ALTER TABLE "resupply"."metric_thresholds"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."metric_thresholds"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."metric_thresholds"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
-- Per-tenant enabled-threshold lookup (the evaluator reads
-- WHERE org_id = … AND enabled). Replace the global enabled index.
DROP INDEX IF EXISTS "resupply"."metric_thresholds_enabled_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_thresholds_org_enabled_idx"
  ON "resupply"."metric_thresholds" ("org_id", "metric_key")
  WHERE "enabled" = true;
--> statement-breakpoint
-- RLS was ENABLEd in 0194 but never got a policy. Add the org_isolation
-- policy (idempotent drop-then-create).
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."metric_thresholds";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."metric_thresholds"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- ── metric_alerts ──
ALTER TABLE "resupply"."metric_alerts"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
-- Backfill from the parent threshold's org where present, else the seed
-- tenant (covers any alert whose threshold was deleted — threshold_id is
-- nullable / ON DELETE CASCADE so a live alert always has one, but be safe).
UPDATE "resupply"."metric_alerts" a
SET "org_id" = COALESCE(
  (SELECT t."org_id" FROM "resupply"."metric_thresholds" t
   WHERE t."id" = a."threshold_id"),
  (SELECT "id" FROM "resupply"."organizations"
   WHERE "slug" = 'penn-home-medical' LIMIT 1)
)
WHERE a."org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."metric_alerts"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_alerts_org_idx"
  ON "resupply"."metric_alerts" ("org_id");
--> statement-breakpoint
ALTER TABLE "resupply"."metric_alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."metric_alerts";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."metric_alerts"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- ── metrics_daily_latest RPC — now per tenant ──
-- The evaluator's batched "latest row per metric_key" read (0232) must now
-- be scoped to the calling tenant. Drop the global single-arg signature (it
-- would read across every tenant after the re-key) and replace it with a
-- two-arg (org, keys) version. The org-scoped DISTINCT ON returns one row
-- per key within that tenant's series.
DROP FUNCTION IF EXISTS resupply.metrics_daily_latest(text[]);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.metrics_daily_latest(
  p_org_id uuid,
  p_metric_keys text[]
)
RETURNS TABLE(
  metric_key text,
  metric_date date,
  metric_value double precision,
  unit text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT DISTINCT ON (metric_key)
    metric_key, metric_date, metric_value, unit
  FROM resupply.metrics_daily
  WHERE org_id = p_org_id
    AND metric_key = ANY(p_metric_keys)
  ORDER BY metric_key, metric_date DESC
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.metrics_daily_latest(uuid, text[])
  TO service_role;
