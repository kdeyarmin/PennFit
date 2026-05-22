-- 0142_inventory_reconciliations — monthly physical-count workflow
-- + low-stock alert dedup state.
--
-- Stripe stays the source of truth for live `stock_count` and
-- `low_stock_threshold` (see lib/stripe/products-meta.ts). These
-- three tables live in Postgres because they are operational
-- workflow records, not catalog state:
--
--   1. inventory_reconciliations         — header row per session
--   2. inventory_reconciliation_lines    — per-SKU count + variance
--   3. low_stock_alert_state             — per-SKU dedup so the
--                                          worker job doesn't spam
--                                          recipients every tick.
--
-- Variance semantics: `variance = counted_qty - system_count`.
-- Positive = counted more than system tracked (excess discovered);
-- negative = counted less (shrinkage / sales not yet reflected).
-- When `system_count IS NULL` (SKU was "untracked" at submit time),
-- variance equals counted_qty by convention so reports still show
-- a delta worth reviewing.

CREATE TABLE IF NOT EXISTS "resupply"."inventory_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Free-form period label (e.g. "2026-05", "Q2 2026 spot-check").
  -- We don't enforce uniqueness — re-running for the same month
  -- after a correction is a valid operational pattern.
  "period_label" text NOT NULL,
  -- 'draft' until submit; 'submitted' once the operator confirmed
  -- the line counts. We deliberately don't model 'cancelled' —
  -- an abandoned draft just stays draft forever and the list page
  -- filters it out after 30 days (UI concern, not schema).
  "status" text NOT NULL DEFAULT 'draft',
  "started_by_email" text NOT NULL,
  "started_by_user_id" text,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "submitted_at" timestamp with time zone,
  "notes" text,
  -- Rolled-up totals stored on the header so the list view doesn't
  -- need to fan out to lines for the summary row. Set at submit
  -- time and never updated afterwards.
  "total_lines" integer NOT NULL DEFAULT 0,
  "total_variance_units" integer NOT NULL DEFAULT 0,
  -- True iff the operator chose to push variances back to Stripe
  -- metadata.stock_count at submit. Stored on the header (not per
  -- line) because v1 is all-or-nothing.
  "applied_to_stripe" boolean NOT NULL DEFAULT false,
  CONSTRAINT "inventory_reconciliations_status_chk"
    CHECK ("status" IN ('draft', 'submitted'))
);
--> statement-breakpoint

-- List page sorts by started_at DESC so this index serves the
-- "most recent reconciliations first" query directly.
CREATE INDEX IF NOT EXISTS "inventory_reconciliations_started_at_idx"
  ON "resupply"."inventory_reconciliations" ("started_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."inventory_reconciliation_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reconciliation_id" uuid NOT NULL REFERENCES "resupply"."inventory_reconciliations"("id") ON DELETE CASCADE,
  -- Stripe product id (prod_*). Stored as text because Stripe ids
  -- are the catalog primary key — there is no products table to
  -- foreign-key against (catalog lives in Stripe).
  "product_id" text NOT NULL,
  -- Snapshot of the product name at submit time. The Stripe name
  -- can change later; the reconciliation record should preserve
  -- what the operator saw when they counted.
  "product_name" text NOT NULL,
  -- NULL means the SKU was untracked in Stripe at submit time.
  -- Variance for that case equals counted_qty (see header comment).
  "system_count" integer,
  "counted_qty" integer NOT NULL,
  -- Stored (not computed) so the report row keeps the exact value
  -- the operator saw — recomputing on read could drift if we ever
  -- change the convention.
  "variance" integer NOT NULL,
  -- True iff this specific line's variance was pushed to Stripe
  -- metadata.stock_count. Per-line because applied_to_stripe on the
  -- header is the intent; failures during the fan-out are recorded
  -- here so a partial-success run is auditable.
  "applied" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_reconciliation_lines_counted_nonneg_chk"
    CHECK ("counted_qty" >= 0),
  -- Defense against a buggy client double-posting the same SKU
  -- inside a single reconciliation. The detail page renders one
  -- row per product so a duplicate is always a bug, not data.
  CONSTRAINT "inventory_reconciliation_lines_unique_per_recon"
    UNIQUE ("reconciliation_id", "product_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inventory_reconciliation_lines_recon_idx"
  ON "resupply"."inventory_reconciliation_lines" ("reconciliation_id");
--> statement-breakpoint

-- Per-SKU dedup state for the low-stock alert worker job.
--
-- Lifecycle: when the worker sees `stock_count <= threshold` for a
-- product, it upserts this row. The job only re-alerts if more than
-- ALERT_COOLDOWN_HOURS have passed since `last_alerted_at` OR the
-- product had been resolved (count went back above threshold) and
-- then dipped again. When stock recovers, the worker stamps
-- `last_resolved_at` so the next dip is treated as a fresh alert.
--
-- Why product_id is the PK (not a synthetic id): there is exactly
-- one alert state per SKU and the worker upserts by product_id.
CREATE TABLE IF NOT EXISTS "resupply"."low_stock_alert_state" (
  "product_id" text PRIMARY KEY NOT NULL,
  -- Snapshot of the count + threshold at the last alert. Useful in
  -- the digest email ("was 3, now 1") and lets ops debug why a
  -- particular alert fired (or didn't).
  "last_observed_count" integer,
  "last_threshold" integer,
  "last_alerted_at" timestamp with time zone,
  "last_resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
