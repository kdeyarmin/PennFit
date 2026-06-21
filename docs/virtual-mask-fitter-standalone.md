# Standalone "Virtual Mask Fitter" plan + product scoping

_Added migration 0419._

CareMetric Breathe's AI mask fitter — text a patient a link, they
self-measure on their phone camera (images never leave the browser), and the
perfect mask **type + size** comes back to the fitter worklist — is also sold
**on its own** as a standalone subscription a DME can buy without the rest of
the resupply suite. This note explains the plan, its pricing, and the
**product-scope** gate that limits a subscriber's console to just the fitter.

> **The fitter is also included in every full-platform plan** (migration
> 0423). Launch/Growth/Scale/Enterprise each carry the same
> `fitterFittingsPerMonth: 25` allowance and bill the same **$2.00**
> per-fitting overage through the shared `fitter_fitting_metered` add-on, so
> the single graduated metered price stays correct across all plans. The
> standalone `mask_fitter` plan below remains the entry tier for a DME that
> wants the fitter and nothing else.

## The plan

Seeded into the platform billing catalog (`resupply.billing_plans`) by
migration 0419, so it flows everywhere the catalog does with no redeploy:
the public marketing pricing page (`GET /api/platform/pricing`), the tenant
self-service billing UI (`/account/billing`), and the Stripe catalog sync.

| Field           | Value                                                             |
| --------------- | ----------------------------------------------------------------- |
| `code`          | `mask_fitter`                                                     |
| Price           | **$149/month**, **no onboarding fee**                             |
| Included usage  | **25 completed fittings/month** (`fitterFittingsPerMonth`)        |
| Overage         | **$2.00 per completed fitting** (add-on `fitter_fitting_metered`) |
| `product_scope` | `mask_fitter` (every other plan is `full`)                        |
| `sort_order`    | `5` — listed before Launch as the entry tier                      |

**Per-fitting metering.** Every fitting that comes back from a patient's
signed link (`POST /shop/fitter-invite/complete`) increments the
`fitterFittingsPerMonth` monthly rollup via `recordTenantUsage(...)`
(`lib/metering/usage.ts`). A patient re-submitting an already-completed
fitting does **not** double-count (only the transition into a completed
state is metered). The billing console reads the rollup in `currentUsage()`
and compares it against the plan's included amount.

## Stripe metered billing (migration 0420)

The per-fitting overage is invoiced through **Stripe Billing Meters**, so it
auto-collects rather than relying on manual reconciliation:

- The `fitter_fitting_metered` add-on is `usage_type='metered'`. On catalog
  sync (`platform-billing/stripe.ts`) it gets a **Stripe Billing Meter**
  (`event_name: "fitter_fitting"`, sum aggregation, customer-keyed) and a
  **graduated metered Price** — first `included_units` (25) free, then $2.00
  each — tied to that meter.
- A tenant on the `mask_fitter` plan has this metered price attached to their
  Stripe subscription **intrinsically** (it's not an opt-in add-on); the
  metered subscription item carries no quantity.
- On each completed fitting, `reportFitterFittingMeterEvent(orgId)` reports a
  meter event keyed by the tenant's Stripe customer. Because meter events are
  customer-keyed, they bill correctly even though the subscription's items are
  deleted/recreated on every sync.

The whole path is **fail-soft and gated**: it no-ops unless platform Stripe
billing is configured and the tenant has a Stripe customer, and every Stripe
call is best-effort. It is also **strictly additive** — a NULL `usage_type`
(every other add-on/plan) bills flat exactly as before. Validate against a
Stripe **test-mode** account before onboarding a real fitter tenant
([runbook](runbooks/stripe-metered-billing-validation.md)).

**The same machinery generalizes to standard-plan overage** (migration 0421):
the SMS / AI / billing-transaction add-ons can bill per-unit overage beyond
each plan's allowance, reported from the `recordTenantUsage` chokepoint via
`reportMeteredOverage`. It is **off by default** behind
`PLATFORM_METERED_OVERAGE_ENABLED` (unset → those add-ons keep billing as flat
bundles, so existing tenants are unchanged). Two price shapes share one code
path: the fitter's `included_units` free tier reports ALL usage (Stripe applies
the tier), while a NULL `included_units` add-on reports only the OVERAGE beyond
the plan allowance against a simple per-unit metered price. Fax and voice stay
flat enablement (no per-unit rate) until one is set.

## Product scope (the "just the fitter" gate)

`billing_plans.product_scope` defaults to `'full'`, so **every existing plan
and every existing tenant is unchanged**. Only a tenant deliberately placed
on the `mask_fitter` plan is scoped down. There are two layers; the server
is the real boundary, the SPA is the matching UX.

**Server (the boundary).** `resolveTenantProductScope(orgId)`
(`artifacts/resupply-api/src/lib/product-scope.ts`) reads the tenant's active
subscription's plan scope (cached). `requireAdmin` — the chokepoint every
admin router delegates through — 403s (`product_scope_restricted`) any admin
request from a `mask_fitter` tenant that falls outside the allowlist in
`isMaskFitterAllowedPath()`: the fitter routes, the tenant's **self-service
subscription** billing (the six `/admin/billing/{package,plans,subscription,
addons,preview,usage-events}` endpoints — **not** the operational claims
worklists that also live under `/admin/billing/`), branding, MFA, staff
seats, and the shell chrome the allowed pages need. The resolver **fails open
to `full`** on any error, so a DB hiccup can never lock a tenant out.
Platform-admin act-as-tenant impersonation is exempt.

**SPA (the UX).** `/me` returns `productScope`. `AppShell` renders the
curated `MASK_FITTER_NAV_GROUPS` (Fitter Invites, Fitter Prospects, branding,
**subscription billing at `/admin/billing/package`** — not the patient-facing
`/account/billing` portal, settings) instead of the full console nav, hides
the full-console chrome (global patient/order search, the admin assistant),
and route-guards any out-of-scope `/admin/*` URL back to the fitter worklist.

The customer-facing fitter flow (`/fitter-invite`, `/api/recommend`,
`/shop/fitter-invite/*`) is public and unaffected — a scoped tenant's
patients complete fittings exactly as before.

## Provisioning a fitter-only tenant

Stand a DME up directly on the plan in one command:

```bash
pnpm --filter @workspace/scripts tenant:onboard \
  --org-slug=acme-sleep --org-name="Acme Sleep" \
  --admin-email=owner@acme.example --plan=mask_fitter
```

`--plan=mask_fitter` writes the tenant's `tenant_billing_subscriptions` row
so their console is fitter-scoped from first sign-in. Omitting `--plan`
leaves the tenant with no subscription (they pick one in-app). Existing
tenants self-subscribe from the billing console — `mask_fitter` is a public,
self-selectable plan. The assignment is idempotent: a tenant that already has
a current plan is never silently switched.

## Upgrading

Switching a tenant from `mask_fitter` to any `full` plan (Launch/Growth/…)
from the platform billing console immediately restores the whole console on
the next `/me` refresh — there is no per-feature migration to run.
