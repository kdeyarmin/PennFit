-- 0365_org_stripe_charges_enabled — Connect onboarding readiness gate (G5).
--
-- Slice C of G5 (Stripe Connect) adds the onboarding flow: a tenant
-- creates an Express connected account and completes Stripe's hosted
-- onboarding. Between "account created" and "onboarding complete" the
-- account exists (its id is stored in `stripe_account_id`, migration 0358)
-- but CANNOT yet accept charges. Routing a Checkout/PaymentIntent to it in
-- that window would fail.
--
-- This flag closes that window: the connected-account resolver
-- (`getConnectedAccountId`, lib/stripe/connect.ts) only routes charges to
-- a tenant whose `stripe_charges_enabled` is TRUE. It's flipped by the
-- `account.updated` Stripe webhook once Stripe reports
-- `charges_enabled: true`, and back to false if Stripe ever disables the
-- account. So creating the account is safe — charges keep flowing through
-- the platform account until onboarding actually completes.
--
-- ADDITIVE and inert by default: NOT NULL DEFAULT false, and the seed
-- tenant (which has no connected account) stays false → platform account,
-- unchanged. Reverse webhook routing (resolveOrgIdByConnectedAccount) does
-- NOT consult this flag — an account.updated event must resolve to its org
-- regardless, in order to FLIP the flag.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "stripe_charges_enabled" boolean NOT NULL DEFAULT false;
