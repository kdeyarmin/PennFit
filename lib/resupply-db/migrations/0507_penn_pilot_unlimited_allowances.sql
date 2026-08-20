-- 0507_penn_pilot_unlimited_allowances — lift every usage allowance for the
-- Penn Home Medical Supply pilot to UNLIMITED, while leaving metering fully
-- intact.
--
-- Why
-- ---
-- Penn is the pilot tenant and should not hit a billing ceiling while they
-- exercise the product. Their Scale plan includes real caps — 40 seats,
-- 10,000 active patients, 2,500 orders/mo, 20,000 outbound messages/mo,
-- and notably just 25 fitter fittings/mo — past which the metered add-ons
-- bill overage.
--
-- What "unlimited" means here, precisely
-- --------------------------------------
-- Allowances have NEVER been an access gate in this codebase: nothing
-- refuses a seat, a patient, an order, or a message because a plan number
-- was reached. They feed exactly two things — the usage-vs-allowance
-- display on /admin/billing/package and the platform console, and
-- `reportMeteredOverage`, which reports billable overage to Stripe.
--
-- So this migration removes the BILLING ceiling, not a functional one, and
-- it deliberately does NOT touch measurement. `recordTenantUsage` writes
-- `tenant_usage_monthly_rollups` before any allowance is consulted, so
-- after this Penn is still metered on every metric and both usage surfaces
-- still show real, live numbers — they simply read "12,431" instead of
-- "12,431 / 20,000". Usage tracking is the point of the exercise for a
-- pilot; only the invoice changes.
--
-- Mechanism
-- ---------
-- `tenant_billing_subscriptions.custom_allowances` is the per-tenant
-- override that already existed for negotiated contracts (the Enterprise
-- plan is `is_custom`). `null` for a metric means "no cap" — deliberately
-- distinct from `0`, which means "none included" (the fitter-only plan
-- uses 0 for the suite metrics it does not sell). Resolution lives in
-- artifacts/resupply-api/src/lib/platform-billing/allowances.ts, which the
-- same commit wires into the overage reporter; both admin surfaces already
-- merged custom over plan the same way.
--
-- Scoped to Penn's ACTIVE subscription row by slug. The plan itself is
-- untouched, so every other tenant on scale_founder keeps the marketed
-- numbers, and the marketed pricing pages are unchanged.
--
-- The eleven keys below are every metric the billing console reports:
-- the five live-counted ones (derived from their own tables on read) plus
-- the six event-based billable ones. Deliberately omitted:
-- aiInputTokensPerMonth / aiOutputTokensPerMonth, which are COST signals
-- folded into vendor COGS rather than billing allowances — no plan caps
-- them and `reportMeteredOverage` already no-ops for them, so declaring
-- them unlimited would state something the billing path never asked.
--
-- REVERSIBLE: set custom_allowances back to '{}' and the plan's numbers
-- apply again on the next metered event. Nothing about the tenant's Stripe
-- subscription composition changes here — the metered add-ons stay
-- attached and simply report zero billable overage.
--
-- Idempotent: keyed UPDATE writing a constant. Per ADR 003 — versioned
-- hand-authored migration.

UPDATE "resupply"."tenant_billing_subscriptions" AS s
SET "custom_allowances" = jsonb_build_object(
      -- Live-counted (read off their own tables).
      'seats',                      NULL,
      'locations',                  NULL,
      'activePatients',             NULL,
      'ordersPerMonth',             NULL,
      'activeSubscriptions',        NULL,
      -- Event-based, billable via metered add-ons.
      'outboundMessagesPerMonth',   NULL,
      'aiTextInteractionsPerMonth', NULL,
      'billingTransactionsPerMonth', NULL,
      'fitterFittingsPerMonth',     NULL,
      'faxEvents',                  NULL,
      'aiVoiceEvents',              NULL
    ),
    "notes" = COALESCE(NULLIF(s."notes", ''), 'Pilot account: allowances lifted to unlimited (migration 0507). Usage is still metered and reported in full; only overage billing is suppressed.'),
    "updated_at" = now()
FROM "resupply"."organizations" AS o
WHERE o."id" = s."org_id"
  AND o."slug" = 'penn-home-medical'
  AND s."status" IN ('active', 'trialing', 'past_due');
