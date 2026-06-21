-- 0423_mask_fitter_in_all_plans — bundle the Virtual Mask Fitter into every
-- platform plan and drop the per-fitting overage rate to $2.00.
--
-- Product change: the AI virtual mask fitter — previously sold only as the
-- standalone `mask_fitter` plan — is now INCLUDED in every full-platform plan
-- (Launch/Growth/Scale/Enterprise). Each gets the SAME 25 completed
-- fittings/month allowance the standalone plan carries, so the single shared
-- Stripe graduated metered price (first `included_units` free, then per-unit)
-- stays correct for every plan that declares the allowance. The per-fitting
-- overage rate drops from $3.00 to $2.00. The standalone $149/mo plan stays
-- as the entry tier (its included fittings + product scope are unchanged; it
-- bills the same $2.00 overage via the shared add-on).
--
-- ADDITIVE / idempotent. Targeted, code-keyed UPDATEs set deterministic
-- values (a jsonb `||` merge + a containment-guarded array append), so a
-- re-run is a no-op. No PHI — global platform-operator catalog data only.

-- ── Per-fitting overage: $3.00 → $2.00 ────────────────────────────────
-- Editing the price invalidates the immutable synced Stripe price, so clear
-- the stored id + synced marker; the next catalog sync mints a fresh metered
-- price at $2.00 (the Billing Meter itself is reused — meters can't be
-- deleted, only deactivated). `included_units` (25) is unchanged.
UPDATE "resupply"."billing_addons"
SET "recurring_price_cents" = 200,
    "stripe_price_id" = NULL,
    "stripe_synced_at" = NULL,
    "updated_at" = now()
WHERE "code" = 'fitter_fitting_metered';
--> statement-breakpoint

-- ── Bundle the fitter allowance into every full-platform plan ──────────
-- `||` merges the key (existing keys are preserved; the right side wins, so a
-- re-run is idempotent). 25/month matches the add-on's `included_units` and
-- the standalone plan, so the shared metered price's free tier is correct for
-- these plans too. Declaring the allowance is what makes
-- syncTenantStripeSubscription attach the intrinsic metered price to these
-- plans' subscriptions (artifacts/resupply-api/src/lib/platform-billing/stripe.ts).
UPDATE "resupply"."billing_plans"
SET "allowances" = "allowances" || '{"fitterFittingsPerMonth":25}'::jsonb,
    "updated_at" = now()
WHERE "code" IN ('launch', 'growth', 'scale', 'enterprise');
--> statement-breakpoint

-- ── Surface the inclusion on the marketing/pricing catalog ────────────
-- Append a fitter feature bullet to each full plan, but only when it isn't
-- already present (jsonb `@>` containment) so the change is idempotent and
-- never clobbers an operator's other edited bullets.
UPDATE "resupply"."billing_plans"
SET "features" = "features" || '["Virtual mask fitter included — 25 fittings/mo, then $2 each"]'::jsonb,
    "updated_at" = now()
WHERE "code" IN ('launch', 'growth', 'scale', 'enterprise')
  AND NOT ("features" @> '["Virtual mask fitter included — 25 fittings/mo, then $2 each"]'::jsonb);
