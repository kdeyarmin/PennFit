-- 0203_mask_fit_outcome_mask_id — RT #22b: attribute a mask-fit outcome
-- to the mask it's about, so the recommendation-engine tuning loop can
-- aggregate seal/comfort signal per mask.
--
-- A #22a outcome binds to a shop_order, not a mask. The survey link is
-- minted per-order by a sender that knows which mask was recommended, so
-- the cleanest attribution is to carry the mask id (the recommendation-
-- engine catalog id, e.g. 'resmed-airfit-f20') in the signed token and
-- persist it here — no fragile order→mask join at read time. Nullable:
-- legacy / un-attributed outcomes simply don't feed the per-mask signal
-- (computeFitAdjustments drops them). Additive. Per ADR 003.

ALTER TABLE "resupply"."mask_fit_outcomes"
  ADD COLUMN IF NOT EXISTS "mask_id" text;
--> statement-breakpoint

-- Per-mask signal aggregation scans by mask.
CREATE INDEX IF NOT EXISTS "mask_fit_outcomes_mask_id_idx"
  ON "resupply"."mask_fit_outcomes" ("mask_id")
  WHERE "mask_id" IS NOT NULL;
