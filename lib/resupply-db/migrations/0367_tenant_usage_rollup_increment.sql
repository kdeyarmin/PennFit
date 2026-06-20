-- 0367_tenant_usage_rollup_increment — atomic per-tenant usage rollup.
--
-- G12 metering. `tenant_usage_monthly_rollups` (migration 0362) is the
-- aggregate the platform billing console reads, but nothing maintained it.
-- This adds the atomic increment used by the usage emitter and the manual
-- operator usage endpoints: one row per (org, month, metric_key), bumped in
-- place. Reading a single rollup row per metric avoids PostgREST's
-- `max_rows` page cap that would silently undercount high-volume per-event
-- reads.
--
-- It also widens `tenant_usage_events.metric_key` to allow the camelCase
-- metric keys the billing console uses (e.g. `aiTextInteractionsPerMonth`).
-- The original 0362 CHECK only permitted `^[a-z0-9_.]+$`, so any insert of a
-- console metric key failed the constraint — leaving the operator audit log
-- unusable for exactly the metrics that matter.
--
-- ADDITIVE / idempotent. No data migration.

ALTER TABLE "resupply"."tenant_usage_events"
  DROP CONSTRAINT IF EXISTS "tenant_usage_events_metric_chk";
--> statement-breakpoint

ALTER TABLE "resupply"."tenant_usage_events"
  ADD CONSTRAINT "tenant_usage_events_metric_chk"
  CHECK ("metric_key" ~ '^[A-Za-z0-9_.]+$');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "resupply"."increment_tenant_usage_rollup"(
  "p_org_id" uuid,
  "p_metric_key" text,
  "p_quantity" integer,
  "p_occurred_at" timestamptz DEFAULT now()
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO "resupply"."tenant_usage_monthly_rollups"
    ("org_id", "month", "metric_key", "quantity", "computed_at")
  VALUES (
    "p_org_id",
    date_trunc('month', "p_occurred_at")::date,
    "p_metric_key",
    GREATEST(COALESCE("p_quantity", 0), 0),
    now()
  )
  ON CONFLICT ("org_id", "month", "metric_key")
  DO UPDATE SET
    "quantity" =
      "resupply"."tenant_usage_monthly_rollups"."quantity" + EXCLUDED."quantity",
    "computed_at" = now();
$$;
