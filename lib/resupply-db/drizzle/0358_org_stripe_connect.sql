-- 0358_org_stripe_connect — per-tenant Stripe Connect account id (G5).
--
-- Phase 2 begins relaxing the single-Stripe-account invariant: today every
-- charge runs through the one platform `STRIPE_SECRET_KEY`. For SaaS, each
-- DME tenant connects THEIR OWN Stripe account, and charges/Checkout
-- sessions are created ON that account via the Stripe `Stripe-Account`
-- header (the SDK's per-request `{ stripeAccount }` option). The platform
-- key stays the API credential; the connected account id selects whose
-- books the money lands in.
--
--   * stripe_account_id — the tenant's connected Stripe account
--     (`acct_…`). NULL means "no connected account" → charges run on the
--     platform account exactly as today (single-tenant unchanged).
--
-- ADDITIVE and inert by default: the column is nullable with no default,
-- the seed tenant (Penn Home Medical Supply) leaves it NULL so its charges
-- continue on the platform account, and the resolver
-- (`lib/stripe/connect.ts`) returns NULL → no `stripeAccount` option →
-- current behavior. A tenant is only switched onto Connect once an
-- operator populates this column (the onboarding/account-link flow is a
-- later G5 slice); until then nothing changes.
--
-- A partial index supports the webhook's reverse lookup (resolve `org_id`
-- from an inbound Connect event's `account`), excluding the common NULL
-- rows.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "stripe_account_id" text;
--> statement-breakpoint

-- One organization per connected account: a given `acct_…` must map back
-- to exactly one tenant for unambiguous webhook routing.
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_stripe_account_id_key"
  ON "resupply"."organizations" ("stripe_account_id")
  WHERE "stripe_account_id" IS NOT NULL;
