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
  (migration **0427**).
- When enforced, `resolveTenantProductScope` returns the **`locked`** scope for
  such a tenant: `requireAdmin` 403s every admin route except billing/checkout
  and account security, and the SPA shows a "pending payment" state with a
  **Pay now** button.
- The lock clears the moment payment lands: the Stripe **`checkout.session.completed`**
  webhook (hosted "Pay now") or **`invoice.paid`** (the invoiced net-15 path)
  sets `billing_required = false`.
- **Re-lock on failed / canceled SaaS billing.** Platform webhook handlers set
  `billing_required = true` again on **`invoice.payment_failed`** and
  **`customer.subscription.deleted`** (still only when
  `BILLING_PAYWALL_ENFORCED` is on). Operators should expect the console to
  collapse back to billing + account security after a declined renewal or
  canceled subscription.
- **OFF by default.** Enforcement is gated by `BILLING_PAYWALL_ENFORCED`; with
  it unset the `billing_required` column has **no effect**. Existing tenants are
  grandfathered (the column defaults `false`, and migration 0362 already gave
  every existing org an active subscription).
- **Fails OPEN.** Any error resolving the scope degrades to `full`, so a DB
  hiccup never locks a tenant out.

## What the wall does NOT gate (by design)

The payment wall is **admin-console only**. It must not block patient care or
platform plumbing while a tenant sorts billing:

| Surface                                                                | Why it stays open                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storefront `/api/*` (fitter, chat, company-info, CSR sign links, auth) | Patients and unsigned visitors must keep working; unpaid SaaS ≠ cut off therapy.                                                                               |
| Auth mounts (storefront / staff / provider)                            | Locking sign-in would strand the admin who needs to pay.                                                                                                       |
| Twilio / Telnyx / SendGrid webhooks and voice / SMS / fax inbound      | Carrier callbacks cannot wait on billing; they stay reachable.                                                                                                 |
| In-process worker (reminders, PHI sweep, therapy sync, …)              | Jobs keep running; unpaid tenants are not silently silenced mid-cycle. Prefer product decisions later if specific non-critical jobs should skip `locked` orgs. |
| Platform-admin / support surfaces                                      | Ops must still reach the tenant to help them pay or unblock.                                                                                                   |

Allowlisted admin paths while `locked` live in `LOCKED_ALLOWED_PREFIXES` in
`artifacts/resupply-api/src/lib/product-scope.ts` (billing package / plans /
subscription / checkout / addons / preview / usage-events, MFA, agreements,
inbox-counts chrome). Do **not** broaden that list to operational PHI routes.

## 0. Preconditions

- **Platform Stripe billing configured** (test mode for validation):
  `STRIPE_PLATFORM_SECRET_KEY` (an `sk_test_…` key) — or shared mode via
  `STRIPE_SECRET_KEY`. **Required before enabling**: without a working
  `invoice.paid` / `checkout.session.completed` webhook there is nothing to
  clear the gate, so a flagged tenant would be locked with no way out.
- The Stripe **webhook** endpoint is receiving events (`checkout.session.completed`,
  `invoice.paid`, `invoice.payment_failed`, `customer.subscription.*`) — same
  endpoint platform billing already uses (`handlePlatformTenantStripeEvent`).
- `preflight:prod` passes with `BILLING_PAYWALL_ENFORCED` set (it FAILs if the
  flag is on without `STRIPE_PLATFORM_SECRET_KEY` or shared
  `STRIPE_SECRET_KEY`, and without the platform webhook secret when using the
  dedicated platform key).
- Migrations through **0427** applied (`RUN_DB_MIGRATIONS=true` on deploy, or
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

## 3b. Confirm re-lock (test mode)

After unlock, force a decline or cancel in the Stripe Dashboard for that
subscription (or send a test `invoice.payment_failed` /
`customer.subscription.deleted` with `metadata.billing_scope = platform_tenant`

- `org_id`). Expect:

```
event=platform_billing_paywall_*   billing_required set   via=invoice.payment_failed
# or via=subscription.deleted
```

Refresh `/admin`: the locked banner returns until they pay again (or you
manually clear `billing_required`).

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
