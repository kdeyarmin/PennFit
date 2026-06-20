-- 0418_mask_fitter_standalone_plan — standalone "Virtual Mask Fitter"
-- platform plan + per-fitting metered add-on, plus a per-plan product
-- scope marker that lets a DME subscribe to JUST the AI mask fitter:
-- text a patient a link, they self-measure on their phone camera, and the
-- perfect mask + size comes back to the fitter worklist — without the rest
-- of the resupply suite.
--
-- ADDITIVE / idempotent. Catalog rows are global platform-operator data;
-- no PHI. The new `product_scope` column DEFAULTS to 'full', so every
-- existing plan (Launch/Growth/Scale/Enterprise) and every existing tenant
-- is completely unchanged — only a tenant deliberately placed on the
-- 'mask_fitter' plan is scoped down. The app reads this scope to gate the
-- admin console + API down to the fitter surfaces (see
-- artifacts/resupply-api/src/lib/product-scope.ts).

-- ── Per-plan product scope ────────────────────────────────────────────
ALTER TABLE "resupply"."billing_plans"
  ADD COLUMN IF NOT EXISTS "product_scope" varchar(40) NOT NULL DEFAULT 'full';

-- Constrain to the known scopes. Drop-then-add so a re-run with an
-- expanded scope list updates the constraint cleanly.
ALTER TABLE "resupply"."billing_plans"
  DROP CONSTRAINT IF EXISTS "billing_plans_product_scope_chk";
ALTER TABLE "resupply"."billing_plans"
  ADD CONSTRAINT "billing_plans_product_scope_chk"
  CHECK ("product_scope" IN ('full', 'mask_fitter'));

-- ── Standalone Virtual Mask Fitter plan ───────────────────────────────
-- Public + self-selectable. Sorted BEFORE Launch (sort_order 5) so it
-- reads as the entry tier. $149/mo base, no onboarding fee, includes 25
-- completed fittings/month; fittings beyond that bill through the
-- `fitter_fitting_metered` add-on below (per-fitting usage pricing). The
-- mask recommendation engine is rule-based (no LLM), so AI-interaction
-- allowance is 0; the only outbound messages are the fitting links, so a
-- small message allowance covers the invites. activePatients headroom is
-- kept modest (fittings auto-attach to a chart when one exists) but is not
-- the focus of the product.
INSERT INTO "resupply"."billing_plans"
  ("code", "name", "description", "monthly_price_cents", "onboarding_fee_cents", "is_public", "is_custom", "sort_order", "allowances", "features", "product_scope")
VALUES
  ('mask_fitter', 'Virtual Mask Fitter',
   'Standalone AI mask fitter for DMEs. Text or email a patient a link, they self-measure on their phone camera, and the perfect mask type + size comes back to your team — no in-office fittings, no sample masks opened just to be thrown away.',
   14900, 0, true, false, 5,
   '{"seats":5,"fitterFittingsPerMonth":25,"activePatients":250,"locations":1,"ordersPerMonth":0,"activeSubscriptions":0,"outboundMessagesPerMonth":500,"aiTextInteractionsPerMonth":0,"billingTransactionsPerMonth":0}'::jsonb,
   '["AI virtual mask fitter — on-device facial measurement","Text or email a fitting link to any patient or prospect","Perfect mask type + size returned to your fitter worklist","Photos never leave the patient''s phone — only measurements","25 completed fittings/month included, then per-fitting pricing"]'::jsonb,
   'mask_fitter')
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthly_price_cents" = EXCLUDED."monthly_price_cents",
  "onboarding_fee_cents" = EXCLUDED."onboarding_fee_cents",
  "is_public" = EXCLUDED."is_public",
  "is_custom" = EXCLUDED."is_custom",
  "sort_order" = EXCLUDED."sort_order",
  "allowances" = EXCLUDED."allowances",
  "features" = EXCLUDED."features",
  "product_scope" = EXCLUDED."product_scope",
  "updated_at" = now();

-- ── Per-fitting metered add-on ────────────────────────────────────────
-- Usage pricing ($3.00 per completed fitting) for fittings beyond the
-- plan's included 25/month. `usage_metric` ties it to the
-- `fitterFittingsPerMonth` monthly rollup the app increments on each
-- completed fitting (artifacts/resupply-api/src/lib/metering/usage.ts).
INSERT INTO "resupply"."billing_addons"
  ("code", "name", "category", "description", "recurring_price_cents", "one_time_min_cents", "one_time_max_cents", "unit_label", "usage_metric", "pass_through_note", "sort_order")
VALUES
  ('fitter_fitting_metered', 'Additional mask fittings', 'usage',
   'Per-fitting pricing for completed virtual mask fittings beyond the plan''s monthly included amount.',
   300, NULL, NULL, 'per completed fitting', 'fitterFittingsPerMonth', NULL, 35)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "recurring_price_cents" = EXCLUDED."recurring_price_cents",
  "unit_label" = EXCLUDED."unit_label",
  "usage_metric" = EXCLUDED."usage_metric",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = now();
