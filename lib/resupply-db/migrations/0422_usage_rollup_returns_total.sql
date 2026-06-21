-- 0422_usage_rollup_returns_total — increment_tenant_usage_rollup now RETURNS
-- the post-increment running total for (org, month, metric).
--
-- Why: metered-overage billing (migration 0421) needs the EXACT total after
-- this increment to compute billable overage atomically. Re-reading the
-- rollup after the increment races concurrent increments and can over-report
-- (over-bill). RETURNING the upsert's resulting quantity is atomic per
-- statement, so each caller sees exactly its own post-increment total.
--
-- Idempotent. Changing the return type (void → integer) requires DROP +
-- CREATE (CREATE OR REPLACE cannot change a function's return type). Existing
-- callers that ignore the return value are unaffected.

DROP FUNCTION IF EXISTS "resupply"."increment_tenant_usage_rollup"(uuid, text, integer, timestamptz);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "resupply"."increment_tenant_usage_rollup"(
  "p_org_id" uuid,
  "p_metric_key" text,
  "p_quantity" integer,
  "p_occurred_at" timestamptz DEFAULT now()
) RETURNS integer
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
    "computed_at" = now()
  RETURNING "quantity";
$$;
