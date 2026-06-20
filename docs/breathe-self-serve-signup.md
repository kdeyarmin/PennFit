# Breathe self-serve demo + account signup

The public **Breathe** marketing site (`/breathe`, and `/` on the platform
home host) lets a prospective DME owner self-serve, with no sales call:

- **Try the demo** — an email gate (modal + inline form) saves the address
  to the marketing list and drops them into the existing client-side demo
  sandbox.
- **Create your account** — `/breathe/signup` provisions a real tenant +
  first admin login, gated by email verification.

## Demo (`?demo=1` sandbox)

The "Start the free demo" CTAs collect an email, `POST /api/demo-lead`
(saved to `public.newsletter_subscribers`, `source="breathe-demo"`,
best-effort), then navigate to `/admin?demo=1`. Demo mode (`src/demo/`)
intercepts every `/api/*` + `/resupply-api/*` call with in-browser
fixtures — **no real patient data, and no integration ever runs**. Nothing
is persisted server-side. The lead-capture route is platform-safe (writes
through the seed-org chokepoint) and per-IP rate-limited + honeypot-guarded.

## Self-serve signup (`POST /api/tenant-signup`)

`createSelfServeTenant()` (`artifacts/resupply-api/src/lib/tenant-signup-service.ts`)
composes the same primitives as the `tenant:onboard` CLI:

1. `resupply.organizations` row (unique slug).
2. Feature flags copied from the seed tenant.
3. Auth user (`role=admin`, `status=invited`) + the password they chose.
4. `signup_verify` email token + verification email.
5. `resupply.admin_users` row linking the admin to the new org.

Guards: per-IP rate limit, honeypot, optional Turnstile, 12-char password
policy, and email verification required before the console is reachable
(the auth user stays `invited` until verified). A brand-new tenant signs in
on the platform admin surface (`/admin/sign-in`); the console resolves them
to their own org via `admin_users.org_id`.

### Production prerequisites (operator-controlled)

These are **fail-soft** — signup works without them in preview — but enable
them before promoting the feature widely:

- **Cloudflare Turnstile (bot protection).** Set `TURNSTILE_SECRET_KEY`.
  When unset, verification is **skipped** (rate limit + honeypot remain the
  guards). When set, the front-end signup form must also render the
  Turnstile widget with the matching site key, or every signup is rejected
  with "could not verify you're human". The app CSP already allows
  `challenges.cloudflare.com`.
- **Wildcard DNS `*.cmbreathe.com`** (optional nicety). New tenants are
  fully usable at `cmbreathe.com/admin` without it; wildcard routing just
  lets them reach `<slug>.cmbreathe.com/admin`.
- **Billing** is deferred: a new admin picks a plan in-app (System
  Configuration → Billing) after verifying; Stripe customer/subscription
  are created lazily at that point.

### Verification status

The HTTP boundary (validation, honeypot, Turnstile, status mapping) and the
demo-lead capture are unit-tested. The end-to-end provisioning path (live
Supabase + SendGrid) is exercised in staging — it reuses the same
battle-tested helpers as the CLI and storefront sign-up rather than new
provisioning code.
