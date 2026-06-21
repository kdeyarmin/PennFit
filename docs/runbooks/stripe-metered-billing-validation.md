# Runbook — validate Stripe metered (usage-based) billing in test mode

Metered billing (migrations 0419/0420) invoices usage that accrues during the
month — the Virtual Mask Fitter's per-fitting overage today, and optionally
SMS/AI/billing overage on the standard plans. Because it moves real money, run
this **once in Stripe test mode** before a real tenant is billed. The whole
path is fail-soft and gated, so a failed step never breaks the app — but a
silent mis-configuration would under/over-bill, which this runbook catches.

## 0. Preconditions

- **Platform Stripe billing configured** in **test mode**: `STRIPE_PLATFORM_SECRET_KEY`
  (an `sk_test_…` key) — or shared mode via `STRIPE_SECRET_KEY` if that's how
  the platform bills. Without it, every metered call no-ops (usage still
  records to the DB rollup).
- Migrations through **0420** applied (`RUN_DB_MIGRATIONS=true` on deploy, or
  run `migrate.mjs`).
- A **test tenant** you can throw away (`tenant:onboard --plan=mask_fitter
--org-slug=metered-test …`).

## 1. Sync the catalog → confirm the meter + metered price exist

Trigger a catalog sync (platform billing console → "Sync to Stripe", or
`POST /platform/billing/catalog/stripe/sync`). Then in the Stripe **test**
dashboard:

1. **Billing → Meters**: a meter named **Additional mask fittings**, event
   name `fitter_fitting`, aggregation **sum**, customer mapping
   `stripe_customer_id`.
2. **Products → the fitter add-on → Price**: a **metered**, **recurring
   monthly** price whose graduated tiers read **first 25 at $0.00, then $2.00
   each** — and **no** top-level unit amount.

If the meter/price is missing, the catalog row's `stripe_meter_id` /
`stripe_price_id` didn't persist — check the sync logs for
`platform_billing_*` errors.

## 2. Assign the plan → confirm the subscription carries the metered item

Put the test tenant on the `mask_fitter` plan (billing console, or it was set
by `--plan=mask_fitter`). This runs `syncTenantStripeSubscription`. In Stripe:

- The tenant's **Customer → Subscription** has **two** items: the **$149/mo
  flat** plan price, and the **metered** fitter price (the metered item shows
  **no quantity** — that's correct; Stripe rejects a quantity on metered
  items).

If the metered item is missing, the plan's `product_scope` isn't resolving to
`mask_fitter`, or the catalog sync hadn't created the price yet.

## 3. Drive usage → confirm meter events land

Complete a fitting end-to-end for the test tenant (open its fitting link →
capture → measure → results, which POSTs `/shop/fitter-invite/complete`).
Repeat to exceed 25 in the month if you want to see the paid tier.

In Stripe **Billing → Meters → the fitter meter → Events**: one event per
completed fitting, payload `{ stripe_customer_id: cus_…, value: "1" }`. App
logs show neither an error nor PHI (event counts only). A re-submit of an
already-completed fitting must **not** add an event (no double-count).

## 4. Confirm the invoice math

Advance the test clock (Stripe **test clocks**) to the period end, or read the
upcoming invoice (`GET /v1/invoices/upcoming?customer=cus_…`). The metered line
should bill **max(0, fittings − 25) × $2.00**, e.g. 30 fittings → $10.00, on
top of the $149 flat plan. 25 or fewer → $0 metered.

## 5. Tear down

Cancel the test subscription, delete the test customer, and archive the test
tenant. Meters can't be deleted, only deactivated — leaving the test meter is
harmless.

---

## Standard-plan overage (SMS / AI / billing transactions) — gated, OFF by default

Beyond the fitter, the same machinery can bill **overage** on the standard
Launch/Growth/Scale plans: each plan includes an allowance per metric
(`outboundMessagesPerMonth`, `aiTextInteractionsPerMonth`,
`billingTransactionsPerMonth`), and usage beyond it bills per-unit.

This is **off by default** behind `PLATFORM_METERED_OVERAGE_ENABLED` — with the
flag unset, those add-ons bill as the existing **flat bundles** and nothing
about existing tenants changes. To validate before enabling:

1. Set `PLATFORM_METERED_OVERAGE_ENABLED=true` in a **test** environment only.
2. Re-sync the catalog + the test tenant's subscription. Confirm a metered
   price + meter per metric (per-unit: messages $0.05, AI $0.04, billing
   transactions $0.075) and a metered item on the subscription for each metric
   the plan has an allowance for.
3. Drive usage past the plan allowance; confirm meter events carry only the
   **overage** (e.g. allowance 1,000 messages, send 1,010 → 10 events) and the
   upcoming invoice bills `overage × per-unit`.
4. Only then set the flag in production. Leaving it unset keeps flat-bundle
   billing.

### Fax / AI-voice per-unit usage (migration 0425)

The fax and AI-voice premium features bill **per-unit usage on top of** their
flat enablement fee: companion metered add-ons `fax_usage` ($0.10 / outbound
fax) and `voice_usage` ($0.50 / completed call). They have **no plan
allowance**, so every event is billable (no free tier), and the **same**
`PLATFORM_METERED_OVERAGE_ENABLED` flag gates them — off by default they are
inert.

Validate them with the same flag on:

1. Confirm a meter + per-unit metered price exists for each (`fax_usage` event
   `fax_usage` @ $0.10; `voice_usage` event `voice_call_usage` @ $0.50).
2. The companion item attaches to a tenant's subscription only when that
   tenant has the **parent feature** active (`fax_automation` /
   `ai_voice_agent`) — it rides on the feature, sharing its `usage_metric`.
3. Drive a fax / a completed call; confirm one meter event per event and that
   the upcoming invoice bills `events × rate` on top of the flat feature fee.

> Voice bills **per completed call** (the `aiVoiceEvents` metric counts calls,
> not minutes). Switching to per-minute would require capturing call duration
> into the usage rollup first.
