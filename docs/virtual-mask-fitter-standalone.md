# Standalone "Virtual Mask Fitter" plan + product scoping

_Added migration 0418._

CareMetric Breathe's AI mask fitter — text a patient a link, they
self-measure on their phone camera (images never leave the browser), and the
perfect mask **type + size** comes back to the fitter worklist — is also sold
**on its own** as a standalone subscription a DME can buy without the rest of
the resupply suite. This note explains the plan, its pricing, and the
**product-scope** gate that limits a subscriber's console to just the fitter.

## The plan

Seeded into the platform billing catalog (`resupply.billing_plans`) by
migration 0418, so it flows everywhere the catalog does with no redeploy:
the public marketing pricing page (`GET /api/platform/pricing`), the tenant
self-service billing UI (`/account/billing`), and the Stripe catalog sync.

| Field           | Value                                                             |
| --------------- | ----------------------------------------------------------------- |
| `code`          | `mask_fitter`                                                     |
| Price           | **$149/month**, **no onboarding fee**                             |
| Included usage  | **25 completed fittings/month** (`fitterFittingsPerMonth`)        |
| Overage         | **$3.00 per completed fitting** (add-on `fitter_fitting_metered`) |
| `product_scope` | `mask_fitter` (every other plan is `full`)                        |
| `sort_order`    | `5` — listed before Launch as the entry tier                      |

**Per-fitting metering.** Every fitting that comes back from a patient's
signed link (`POST /shop/fitter-invite/complete`) increments the
`fitterFittingsPerMonth` monthly rollup via `recordTenantUsage(...)`
(`lib/metering/usage.ts`). A patient re-submitting an already-completed
fitting does **not** double-count (only the transition into a completed
state is metered). The billing console reads the rollup in `currentUsage()`
and compares it against the plan's included amount.

## Product scope (the "just the fitter" gate)

`billing_plans.product_scope` defaults to `'full'`, so **every existing plan
and every existing tenant is unchanged**. Only a tenant deliberately placed
on the `mask_fitter` plan is scoped down. There are two layers; the server
is the real boundary, the SPA is the matching UX.

**Server (the boundary).** `resolveTenantProductScope(orgId)`
(`artifacts/resupply-api/src/lib/product-scope.ts`) reads the tenant's active
subscription's plan scope (cached ~5s). `requireAdmin` — the chokepoint every
admin router delegates through — 403s (`product_scope_restricted`) any admin
request from a `mask_fitter` tenant that falls outside the allowlist in
`isMaskFitterAllowedPath()` (the fitter routes, the tenant's own
billing/branding/account settings, and the shell chrome the allowed pages
need). The resolver **fails open to `full`** on any error, so a DB hiccup can
never lock a tenant out. Platform-admin act-as-tenant impersonation is exempt.

**SPA (the UX).** `/me` returns `productScope`. `AppShell` renders the
curated `MASK_FITTER_NAV_GROUPS` (Fitter Invites, Fitter Prospects, branding,
billing, settings) instead of the full console nav, and a route guard
redirects any out-of-scope `/admin/*` URL back to the fitter worklist.

The customer-facing fitter flow (`/fitter-invite`, `/api/recommend`,
`/shop/fitter-invite/*`) is public and unaffected — a scoped tenant's
patients complete fittings exactly as before.

## Upgrading

Switching a tenant from `mask_fitter` to any `full` plan (Launch/Growth/…)
from the platform billing console immediately restores the whole console on
the next `/me` refresh — there is no per-feature migration to run.
