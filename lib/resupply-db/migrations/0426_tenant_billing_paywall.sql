-- 0426: tenant payment wall — gate a new self-serve tenant out of the full
-- console until they have paid.
--
-- Adds `organizations.billing_required`. A new self-serve sign-up (web form OR
-- voice agent) sets it TRUE; the platform's product-scope resolver then treats
-- such a tenant as "locked" — restricted to the billing/checkout + account
-- surfaces — until their first invoice is paid, at which point the Stripe
-- `invoice.paid` webhook clears the flag.
--
-- DEFAULT false → every EXISTING organization is grandfathered (never locked):
-- migration 0362 already seeded each existing org an active 'launch'
-- subscription, and only rows explicitly flagged here are gated.
--
-- Enforcement is additionally env-gated (BILLING_PAYWALL_ENFORCED) and OFF by
-- default, so this column has NO behavioural effect until an operator turns the
-- wall on — the flag can be backfilled/observed safely first.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.
ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "billing_required" boolean NOT NULL DEFAULT false;
