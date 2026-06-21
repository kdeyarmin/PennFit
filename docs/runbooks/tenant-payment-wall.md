# Runbook — validate + enable the tenant payment wall

The payment wall locks a **new self-serve tenant** out of the full admin
console until they pay. It moves real money and gates console access, so
validate it on a **preview with Stripe in test mode** before turning it on in
production. The whole path is **fail-soft and OFF by default**, so a missed
step never breaks the app — but a silent mis-configuration would either lock a
paying tenant out or let an unpaid one in, which this runbook catches.

## What it does (and the safety posture)

- A new self-serve sign-up — web form **or** voice agent — must choose a plan,
  and the org is created with `organizations.billing_required = true`
  (migration **0426**).
- When enforced, `resolveTenantProductScope` returns the **`locked`** scope for
  such a tenant: `requireAdmin` 403s every admin route except billing/checkout
  and account security, and the SPA shows a "pending payment" state with a
  **Pay now** button.
- The lock clears the moment payment lands: the Stripe **`checkout.session.completed`**
  webhook (hosted "Pay now") or **`invoice.paid`** (the invoiced net-15 path)
  sets `billing_required = false`.
- **OFF by default.** Enforcement is gated by `BILLING_PAYWALL_ENFORCED`; with
  it unset the `billing_required` column has **no effect**. Existing tenants are
  grandfathered (the column defaults `false`, and migration 0362 already gave
  every existing org an active subscription).
- **Fails OPEN.** Any error resolving the scope degrades to `full`, so a DB
  hiccup never locks a tenant out.

## 0. Preconditions

- **Platform Stripe billing configured** (test mode for validation):
  `STRIPE_PLATFORM_SECRET_KEY` (an `sk_test_…` key) — or shared mode via
  `STRIPE_SECRET_KEY`. **Required before enabling**: without a working
  `invoice.paid` / `checkout.session.completed` webhook there is nothing to
  clear the gate, so a flagged tenant would be locked with no way out.
- The Stripe **webhook** endpoint is receiving events (`checkout.session.completed`,
  `invoice.paid`, `customer.subscription.*`) — same endpoint platform billing
  already uses (`handlePlatformTenantStripeEvent`).
- Migrations through **0426** applied (`RUN_DB_MIGRATIONS=true` on deploy, or
  run `migrate.mjs`).
- A **throwaway test tenant** you can create via the public sign-up (you do NOT
  need `tenant:onboard` — the point is to exercise the self-serve path that
  sets `billing_required`).

## 1. Turn it on for the preview

Set on the preview environment and redeploy (or restart):

```
BILLING_PAYWALL_ENFORCED=1
```

(Existing preview tenants are unaffected — only orgs created with
`billing_required = true` are gated.)

## 2. Create a new tenant and confirm it's locked

1. Go to the Breathe sign-up (`/breathe` create-account form), pick a plan,
   and finish sign-up. (Or place a sales call to the voice line and let the
   agent sign you up.)
2. Verify the email / set the password, then sign in to `/admin`.
3. **Expect the locked state:** the console shows only **Billing & payment**
   and **Account security**, a "pending payment" banner is visible, and
   deep-linking to e.g. `/admin/patients` bounces you to the billing page.
   Hitting an operational API directly returns `403 product_scope_restricted`
   with `productScope: "locked"`.

> Sanity check the grandfathering at the same time: an EXISTING tenant (e.g.
> the seed tenant) should still see the full console — it is not locked.

## 3. Pay and confirm the unlock

**Hosted "Pay now" (instant):**

1. Click **Pay now & unlock**. You're redirected to Stripe Checkout.
2. Pay with a Stripe **test card** (`4242 4242 4242 4242`, any future expiry /
   CVC / ZIP).
3. Stripe redirects back to `/admin/billing/package?checkout=success`. Within a
   few seconds (webhook + the 5s scope cache) the lock clears: refresh and the
   full console is back. Confirm `organizations.billing_required` is now
   `false` for that org, and `tenant_billing_subscriptions` has the Stripe
   subscription id.

**Invoiced path (alternative):** select/confirm a plan on the billing page →
the tenant is invoiced → pay the Stripe-hosted invoice → `invoice.paid` clears
the gate. Same end state.

Check the logs for the unlock signal:

```
event=platform_billing_paywall_cleared   org_id=<org>   via=checkout   # or invoice.paid
```

## 4. Enable in production

Only after the preview run passes **and** production Stripe billing is
confirmed working:

```
BILLING_PAYWALL_ENFORCED=1
```

From then on, every NEW self-serve tenant is gated until they pay; existing
tenants are untouched.

## Rollback (instant)

Unset `BILLING_PAYWALL_ENFORCED` (or set it to anything non-truthy) and
redeploy/restart. Enforcement stops immediately — every tenant resolves on
plan scope again, regardless of `billing_required`. No migration rollback is
needed; the column is inert when unenforced.

## Troubleshooting

- **A new tenant is stuck locked after paying.** Confirm the Stripe webhook is
  reaching `handlePlatformTenantStripeEvent` and that the subscription/session
  carries `metadata.billing_scope = platform_tenant` + `org_id` (the webhook
  ignores events without them). As a manual unblock, set
  `organizations.billing_required = false` for that org.
- **A tenant is locked but Stripe is unconfigured** (e.g. the flag got enabled
  in an env with no Stripe). There is no `invoice.paid` to unlock them — unset
  `BILLING_PAYWALL_ENFORCED` until Stripe is configured. (This is why §0 makes
  Stripe a hard precondition.)
- **An EXISTING tenant got locked.** It shouldn't — they carry an active
  subscription and `billing_required = false`. If one is flagged, clear the
  column for that org; do not disable the wall globally.
- **The "Pay now" button 503s.** Platform Stripe billing isn't configured in
  that environment; the route returns `503 billing_unconfigured` by design.
  Use the invoiced path or configure Stripe.

## Related

- Enforcement gate + scope resolution: `artifacts/resupply-api/src/lib/product-scope.ts`.
- Checkout session + webhook unlock: `artifacts/resupply-api/src/lib/platform-billing/stripe.ts`.
- Signup sets the flag: `artifacts/resupply-api/src/lib/tenant-signup-service.ts`.
- Migration: `lib/resupply-db/migrations/0427_tenant_billing_paywall.sql`.
- Env reference: `.env.example` (`BILLING_PAYWALL_ENFORCED`).
