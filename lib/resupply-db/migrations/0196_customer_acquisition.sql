-- 0196_customer_acquisition — Biller/Owner #3: LTV & CAC cohort economics.
--
-- The app tracks revenue per customer (shop_orders) and signup date
-- (shop_customers.created_at) but never WHERE a customer came from or
-- what they cost to acquire. Owner #3 (lifetime value per patient;
-- acquisition cost by source) is blocked on that one fact.
--
-- This adds a single per-customer attribution row:
--   * channel        — the acquisition source bucket (organic, paid_search,
--                       paid_social, referral, fitter, insurance_lead,
--                       partner, other). CHECK-constrained.
--   * acquisition_cost_cents — what THIS customer cost to acquire, when
--                       known (e.g. allocated ad spend). NULLABLE — null
--                       = "cost unknown", never silently zero, mirroring
--                       the F1 cost-capture honesty rule. CAC is computed
--                       over the costed subset only.
--   * source_detail  — optional free-text/campaign id (utm_campaign, the
--                       referring fitter, etc). Not PHI — marketing
--                       attribution, no clinical data.
--   * acquired_at    — when the attribution was recorded (defaults now()).
--
-- One row per customer_id (PK), so re-recording attribution is an UPSERT.
-- RLS deny-all (service-role only), matching every resupply table. The
-- cohort/LTV/CAC rollup reads this joined to shop_orders; no value is
-- stored that shop_orders already derives.
--
-- Additive, no backfill (existing customers simply have no attribution
-- row yet → surfaced as an "unattributed" cohort, honestly). Per
-- ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."customer_acquisition" (
  "customer_id" text PRIMARY KEY,
  "channel" text NOT NULL DEFAULT 'other',
  "acquisition_cost_cents" integer,
  "source_detail" text,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "recorded_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "resupply"."customer_acquisition"
  DROP CONSTRAINT IF EXISTS "customer_acquisition_channel_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."customer_acquisition"
  ADD CONSTRAINT "customer_acquisition_channel_enum"
  CHECK ("channel" IN (
    'organic', 'paid_search', 'paid_social', 'referral',
    'fitter', 'insurance_lead', 'partner', 'other'
  ));
--> statement-breakpoint

-- Non-negative cost when present (null stays allowed = unknown).
ALTER TABLE "resupply"."customer_acquisition"
  DROP CONSTRAINT IF EXISTS "customer_acquisition_cost_nonneg";
--> statement-breakpoint
ALTER TABLE "resupply"."customer_acquisition"
  ADD CONSTRAINT "customer_acquisition_cost_nonneg"
  CHECK ("acquisition_cost_cents" IS NULL OR "acquisition_cost_cents" >= 0);
--> statement-breakpoint

-- Channel rollups scan by channel.
CREATE INDEX IF NOT EXISTS "customer_acquisition_channel_idx"
  ON "resupply"."customer_acquisition" ("channel");
--> statement-breakpoint

ALTER TABLE "resupply"."customer_acquisition"
  ENABLE ROW LEVEL SECURITY;
