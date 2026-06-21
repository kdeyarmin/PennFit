-- 0426_founder_launch_pricing — Founder DME Launch pricing.
--
-- Adds discounted "founder" twins of the full-platform plans (launch_founder /
-- growth_founder / scale_founder) at the launch-promo rate: a lower monthly
-- base PLUS a per-active-patient monthly charge, with the rate guaranteed for
-- 12 months. These become the publicly-offered full plans during the founder
-- launch; the standard launch/growth/scale plans are hidden (is_public=false)
-- but kept as the "regular price" reference shown struck-through on the
-- pricing page, and existing tenants already on them are unaffected
-- (is_public is display-only; it does not change any active subscription).
--
-- The per-active-patient charge is billed QUANTITY-BASED: a per-unit price
-- (per_active_patient_cents) whose Stripe subscription-item quantity is the
-- tenant's billable active-patient count, recomputed monthly by a job and
-- stored on tenant_billing_subscriptions.billable_active_patients.
--
-- Additive + safe: no tenant is on a founder plan yet, so nothing bills
-- differently until a DME is deliberately onboarded onto one (validate in
-- Stripe test mode first — docs/runbooks/stripe-metered-billing-validation.md).

ALTER TABLE "resupply"."billing_plans"
  ADD COLUMN IF NOT EXISTS "per_active_patient_cents" integer,
  ADD COLUMN IF NOT EXISTS "regular_monthly_price_cents" integer,
  ADD COLUMN IF NOT EXISTS "founder_rate_locked_months" integer,
  ADD COLUMN IF NOT EXISTS "stripe_per_patient_price_id" text;
--> statement-breakpoint

ALTER TABLE "resupply"."billing_plans"
  DROP CONSTRAINT IF EXISTS "billing_plans_per_patient_chk";
--> statement-breakpoint
ALTER TABLE "resupply"."billing_plans"
  ADD CONSTRAINT "billing_plans_per_patient_chk"
  CHECK ("per_active_patient_cents" IS NULL OR "per_active_patient_cents" >= 0);
--> statement-breakpoint

-- Latest billable active-patient count for this tenant (recomputed monthly by
-- the founder-billing job). Drives the per-patient subscription-item quantity.
ALTER TABLE "resupply"."tenant_billing_subscriptions"
  ADD COLUMN IF NOT EXISTS "billable_active_patients" integer;
--> statement-breakpoint

-- Founder plans: same allowances/features/scope as their standard twins, lower
-- base + per-active-patient charge, regular price recorded for the discount
-- display, rate locked 12 months. sort_order interleaves them ahead of the
-- (now hidden) standard rows.
INSERT INTO "resupply"."billing_plans"
  ("code", "name", "description", "monthly_price_cents", "onboarding_fee_cents",
   "is_public", "is_custom", "sort_order", "allowances", "features",
   "per_active_patient_cents", "regular_monthly_price_cents",
   "founder_rate_locked_months")
VALUES
  ('launch_founder','Launch','Branded CPAP storefront and basic resupply automation for a small DME.',49900,250000,true,false,10,'{"seats":5,"activePatients":500,"locations":1,"ordersPerMonth":150,"activeSubscriptions":250,"outboundMessagesPerMonth":1000,"aiTextInteractionsPerMonth":1000,"billingTransactionsPerMonth":0,"fitterFittingsPerMonth":25}'::jsonb,'["Branded CPAP storefront + mask fitter","Online shop, cart, checkout, and order tracking","Customer accounts and basic messaging","Resupply reminders and subscription tracking","Orders, returns, inventory, and customer leads"]'::jsonb,125,79900,12),
  ('growth_founder','Growth','Full resupply operations, outreach, documents, therapy monitoring, and billing worklists.',150000,500000,true,false,20,'{"seats":15,"activePatients":3000,"locations":3,"ordersPerMonth":750,"activeSubscriptions":1500,"outboundMessagesPerMonth":5000,"aiTextInteractionsPerMonth":5000,"billingTransactionsPerMonth":1000,"fitterFittingsPerMonth":25}'::jsonb,'["Everything in Launch","Bulk campaigns, playbooks, and templates","Patient packets, e-signature tracking, inbound fax triage","Eligibility, prior auth, CMN/DIF, bill-hold, and A/R worklists","Therapy monitoring and resupply opportunities"]'::jsonb,95,189900,12),
  ('scale_founder','Scale','Multi-location automation, analytics, AI controls, and higher-volume operations.',319900,1000000,true,false,30,'{"seats":40,"activePatients":10000,"locations":10,"ordersPerMonth":2500,"activeSubscriptions":5000,"outboundMessagesPerMonth":20000,"aiTextInteractionsPerMonth":20000,"billingTransactionsPerMonth":5000,"fitterFittingsPerMonth":25}'::jsonb,'["Everything in Growth","Multi-location workflows","Advanced financial, funnel, LTV/CAC, and inventory analytics","Team throughput, live staffing, goals, and KPI alerts","Automation rules, Control Center, and bot playground"]'::jsonb,65,399900,12)
ON CONFLICT ("code") DO UPDATE SET
  "monthly_price_cents" = EXCLUDED."monthly_price_cents",
  "per_active_patient_cents" = EXCLUDED."per_active_patient_cents",
  "regular_monthly_price_cents" = EXCLUDED."regular_monthly_price_cents",
  "founder_rate_locked_months" = EXCLUDED."founder_rate_locked_months",
  "is_public" = EXCLUDED."is_public",
  "allowances" = EXCLUDED."allowances",
  "features" = EXCLUDED."features",
  "updated_at" = now();
--> statement-breakpoint

-- Founder twin of the standalone Virtual Mask Fitter plan: a flat $119/mo
-- (regular $149), no per-active-patient charge, same fitter scope/allowances
-- (25 fittings/mo + $2 overage), rate locked 12 months.
INSERT INTO "resupply"."billing_plans"
  ("code", "name", "description", "monthly_price_cents", "onboarding_fee_cents",
   "is_public", "is_custom", "sort_order", "allowances", "features",
   "product_scope", "regular_monthly_price_cents", "founder_rate_locked_months")
VALUES
  ('mask_fitter_founder', 'Virtual Mask Fitter',
   'Standalone AI mask fitter for DMEs. Text or email a patient a link, they self-measure on their phone camera, and the perfect mask type + size comes back to your team — no in-office fittings, no sample masks opened just to be thrown away.',
   11900, 0, true, false, 5,
   '{"seats":5,"fitterFittingsPerMonth":25,"activePatients":250,"locations":1,"ordersPerMonth":0,"activeSubscriptions":0,"outboundMessagesPerMonth":500,"aiTextInteractionsPerMonth":0,"billingTransactionsPerMonth":0}'::jsonb,
   '["AI virtual mask fitter — on-device facial measurement","Text or email a fitting link to any patient or prospect","Perfect mask type + size returned to your fitter worklist","Photos never leave the patient''s phone — only measurements","25 completed fittings/month included, then per-fitting pricing"]'::jsonb,
   'mask_fitter', 14900, 12)
ON CONFLICT ("code") DO UPDATE SET
  "monthly_price_cents" = EXCLUDED."monthly_price_cents",
  "regular_monthly_price_cents" = EXCLUDED."regular_monthly_price_cents",
  "founder_rate_locked_months" = EXCLUDED."founder_rate_locked_months",
  "is_public" = EXCLUDED."is_public",
  "allowances" = EXCLUDED."allowances",
  "features" = EXCLUDED."features",
  "updated_at" = now();
--> statement-breakpoint

-- Hide the standard plans: the founder twins are the offer now. Existing
-- subscriptions on these plans are unchanged (display-only flag).
UPDATE "resupply"."billing_plans"
SET "is_public" = false, "updated_at" = now()
WHERE "code" IN ('launch','growth','scale','mask_fitter');
--> statement-breakpoint

-- Billing-grade active-patient count: a patient who is active AND has an active
-- prescription (resupply-eligible) AND had an outbound touch or a fulfillment
-- in the trailing 90 days. Scoped by patients.org_id; activity joined by
-- patient. STABLE (read-only). Returns 0 for an org with no qualifying rows.
CREATE OR REPLACE FUNCTION "resupply"."count_active_patients_for_billing"(
  "p_org_id" uuid
) RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(DISTINCT p.id)::integer
  FROM "resupply"."patients" p
  WHERE p."org_id" = "p_org_id"
    AND p."status" = 'active'
    AND EXISTS (
      SELECT 1 FROM "resupply"."prescriptions" pr
      WHERE pr."patient_id" = p."id"
        AND pr."status" = 'active'
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "resupply"."messages" m
        JOIN "resupply"."conversations" c ON c."id" = m."conversation_id"
        WHERE c."patient_id" = p."id"
          AND m."direction" = 'outbound'
          AND m."created_at" >= now() - INTERVAL '90 days'
      )
      OR EXISTS (
        SELECT 1 FROM "resupply"."fulfillments" f
        WHERE f."patient_id" = p."id"
          AND f."created_at" >= now() - INTERVAL '90 days'
      )
    );
$$;
