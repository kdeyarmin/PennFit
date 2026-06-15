# Multi-Tenant: Remaining Work Plan

**Date:** 2026-06-15
**Status:** Plan / direction-setting — gap review against a working tree
where **Phase 0 is complete and merged**.
**Parents:**
[`multi-tenant-caremetric-strategy-2026-06-14.md`](./multi-tenant-caremetric-strategy-2026-06-14.md),
[`multi-tenant-phase-0-engineering-plan-2026-06-14.md`](./multi-tenant-phase-0-engineering-plan-2026-06-14.md),
[`multi-tenant-cutover-playbook-2026-06-14.md`](./multi-tenant-cutover-playbook-2026-06-14.md)

This document reviews the **entire app as it stands today** and enumerates
the work still required to turn CareMetric Breathe from an
*isolation-ready single-tenant deployment* into an *operationally
multi-tenant SaaS* that can serve a second DME company end-to-end.

---

## TL;DR — where we actually are

The hard part is **done**. Tenant isolation is now a structural property of
the code:

- `organizations` table exists; every tenant-scoped table carries a
  `NOT NULL`, indexed, FK'd `org_id` (migrations `0331`–`0351`).
- All application **and** worker data access flows through
  `getOrgScopedClient(orgId)`; the direct-`service_role` baseline is **0**
  and `check-tenant-isolation.sh` is in **fail** mode.
- RLS `org_isolation` policies exist on every tenant-scoped table
  (`0348`) as the defense-in-depth backstop.
- `tenant:onboard` CLI stands up a new org + first admin + feature flags.
- Per-tenant **feature flags** (`(org_id, key)`, `0350`).
- Per-tenant **storefront branding** (name / tagline / logo) + **custom
  domain** verification + **Cloudflare-for-SaaS TLS** automation
  (`0346`/`0347`); `resolveBrandingByHost()` serves brand by host.

What this means: **isolation is safe** — a new `organizations` row cannot
read or write another tenant's data. But several **runtime serving paths
are still hard-pinned to the seed org**, and the **per-tenant external
identity / platform-operations** layers are not built. A second tenant
onboarded today would get correct branding on their domain but would
**share PennPaps' catalog, customers, Stripe account, email sender, phone
numbers, and would never have its background jobs run**.

---

## The load-bearing gaps (must-fix before a 2nd tenant goes live)

These are the items that make the difference between "isolation-ready" and
"actually serves tenant #2." They are ordered by how badly they block a
real second customer.

### G1. Public storefront + customer portal data is pinned to the seed org — **blocker**

`requireSignedIn` and every `routes/storefront/*` handler resolve the
tenant with `resolveSeedOrgId()`, not by host:

- `artifacts/resupply-api/src/middlewares/requireSignedIn.ts:152` —
  `req.orgId = (await resolveSeedOrgId())` with the comment
  *"Single-tenant today → the seed org; later reads shop_customers.org_id."*
- `routes/storefront/{orders,reminders,csr-orders,...}.ts` all call
  `resolveSeedOrgId()` directly.

Branding resolves by host (`resolveBrandingByHost`) but **data does not**.
A second tenant's storefront would render their logo over PennPaps'
catalog, customers, and orders.

**Work:**
1. Add `resolveOrgIdByHost(host)` next to `resolveBrandingByHost` (reuse
   the same verified-`custom_domain` → `organizations.id` lookup + cache)
   in `lib/tenant-branding.ts` / a new `lib/tenant-context.ts`.
2. In `requireSignedIn`, resolve `org_id` from the authenticated
   `shop_customers.org_id` first (the row already carries it post-0334);
   fall back to host resolution for the pre-auth/guest catalog surface.
3. Replace `resolveSeedOrgId()` in `routes/storefront/**` with the
   host-/customer-derived org. Keep seed fallback **only** for the apex
   `pennfit.up.railway.app` host so single-tenant stays correct.
4. Signed patient links (SMS/email reminders via `RESUPPLY_LINK_HMAC_KEY`)
   must encode/resolve `org_id` so a click-through lands in the right
   tenant — audit `lib/resupply-reminders` + the link verifier.
5. Extend the cross-tenant leakage test to cover a storefront/customer
   request on tenant B's host.

### G2. Scheduled worker jobs only process the seed org — **blocker**

The cutover scoped *job bodies* correctly, but the *schedulers* resolve a
single org. e.g. `worker/jobs/reminders.ts:428,916` →
`const orgId = await resolveSeedOrgId()`. The nightly/periodic crons
(reminders, cart-abandonment, recall, bill-hold sweep, eligibility
re-verify, claims autosubmit, therapy nightly sync, PHI sweep, onboarding
check-ins…) therefore **never run for any tenant but PennPaps**.

**Work:**
1. Add a `listActiveOrgIds()` helper (`organizations WHERE status='active'`).
2. Convert each recurring cron from "do work for seed org" to "enqueue one
   per-org job item per active org" — the per-item handler already takes an
   `orgId` and builds `getOrgScopedClient(orgId)`. The pg-boss payload
   carries `org_id` (the playbook's worker contract).
3. Audit the handful of raw-`pg` worker paths (`getDbPool()`, e.g.
   `worker/jobs/bulk-campaign-tick.ts`) — these bypass the facade and must
   take an explicit `WHERE org_id = $1`.
4. Per-tenant cron **enable** flags: respect each org's feature flags so a
   tenant that hasn't bought (say) voice outreach isn't swept.

### G3. `app_config` is still a global singleton — **blocker for credentials**

`app_config` has an `org_id` column (`0336`) but the reader/store
(`lib/app-config/{store,catalog}.ts`) treats it as a **single global row
per key** and folds values into `process.env` at boot. So every tenant
shares one `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `AIRVIEW_CLIENT_ID`,
assistant names, etc. (Assistant *names* are per-tenant only by accident
of the seed having a row.)

**Work:**
1. Re-key `app_config` to `(org_id, key)` like feature flags (`0350` is the
   template), with seed-org fallback for unset (org, key) rows.
2. Split the catalog into **platform-global** keys (infra: Supabase, link
   HMAC, storage bucket — never per-tenant) vs **tenant-overridable** keys
   (assistant names, branding text, integration creds, thresholds).
3. Replace the boot-time `process.env` overlay with a **request-scoped**
   effective-config read for tenant-overridable keys (the env overlay only
   works for one tenant). Workers read per-org config from the job payload's
   `orgId`.
4. Update `/admin/system/configuration` to write the caller's `org_id`.

### G4. No platform super-admin surface — **operational blocker**

`requireAdmin` reads `auth.users.role` ∈ {admin, agent} and every admin is
bound to exactly one `org_id`. There is **no role above tenant admin** and
no cross-tenant console. Today onboarding/suspending tenants is a CLI/SQL
operation; there is no UI to manage tenants, see platform-wide usage, or
impersonate for support.

**Work:**
1. Add a `platform_admin` (super-admin) capability — either a new role on
   `auth.users` or a separate `platform_admins` table — explicitly **not**
   scoped to one org.
2. A `requirePlatformAdmin` gate + a small `/platform/*` console:
   list/create/suspend tenants, view per-org usage, trigger
   `tenant:onboard` from the UI, manage custom domains.
3. Scoped **support impersonation** ("act as tenant X") with an audit trail,
   since the no-audit-machinery rule means this needs a deliberate, minimal
   log.

---

## Phase 2 — Per-tenant external identity (revenue + deliverability)

Each tenant must bill, email, and text under **their own** identity. All of
these intentionally relax current single-valued invariants.

### G5. Stripe → Stripe Connect

Today Stripe is single-account (`STRIPE_SECRET_KEY`, one set of products in
`lib/stripe/`). For SaaS, each DME connects their own Stripe account.

**Work:** Stripe **Connect** (Standard/Express accounts). Store
`stripe_account_id` on `organizations`; route Checkout/PaymentIntents with
`stripeAccount`; optional `application_fee` for platform revenue share;
per-account webhook routing (resolve `org_id` from the Connect account id).
Seed catalog/products become per-tenant.

### G6. Per-tenant email From address

The **"one From address" hard rule** (`info@pennpaps.com`, enforced in
`createSendgridClient()` + `preflight:prod`) must become **one From address
*per tenant***. This is a deliberate, documented relaxation of a current
hard rule — CLAUDE.md and the preflight check must be updated in lockstep.

**Work:** add `from_email` / `from_name` (+ sending-domain/subuser state) to
`organizations`; have `createSendgridClient()` accept a per-tenant sender;
SendGrid **authenticated sending domains** or **subusers** per tenant;
update the inbound-parse reply path. Keep a platform fallback for
unconfigured tenants.

### G7. Per-tenant telecom (Twilio)

SMS + voice currently use one Twilio identity. No subaccount logic exists.

**Work:** per-tenant Twilio **subaccounts** or at least per-tenant
**Messaging Service SID** / from-numbers stored on `organizations`; route
the inbound webhooks (SMS, voice, MMS) to the right `org_id` by the
**called number**; per-tenant voice agent config (the agent prompt/brand
already normalizes via `applyPlatformBranding`).

### G8. Clearinghouse / payer creds per tenant

`clearinghouse_credentials` is already org-scoped (multi-row, scoped via
#950). **Verify** Office Ally / Availity / DaVinci PAS submission paths read
the caller's org creds + NPI/PTAN end-to-end (837P/835 builders, SFTP
outbox), and that the `dme_organization` billing identity (NPI/PTAN/tax id)
is per-tenant. Mostly verification + closing any remaining seed-pinned reads.

---

## Phase 1 finish — branding polish

### G9. Admin theme driven by org branding

Admin tokens (`--penn-navy`, etc.) are hardcoded in `src/admin.css` under
`.admin-root`. Drive them from the tenant's branding (logo already is).
Respect the **hard rule**: re-point only the **raw** `--background` /
`--foreground` vars under `.admin-root`, never add a global `@theme` block
(see `admin.scope.test.ts`). Lower priority — cosmetic, not a blocker.

---

## Phase 3 finish — routing & onboarding

- **G10. Subdomain routing** (`acme.caremetric.ai`) in addition to custom
  domains — resolve `org_id` from the subdomain label as a zero-DNS-setup
  default. Custom-domain path (`0346`/`0347`) already exists; this is the
  cheaper onboarding default.
- **G11. Self-serve onboarding** on top of the `tenant:onboard` CLI — the
  super-admin console (G4) is the minimum; a true self-serve signup is
  optional.

## Phase 0 commercial — usage metering

- **G12. Per-org usage metering.** The strategy doc calls for building
  `org_id`-scoped usage metering *in Phase 0 so billing isn't retrofitted*
  — this was **not** built. Add a metering table (active patients / messages
  / orders per org per period) and a rollup the platform console reads.
  Needed before per-active-patient pricing.

## Phase 4 — CareMetric cross-linking (later, optional)

- **G13.** Deep links between the CareMetric EMR and Resupply.
- **G14.** Wire the EMR as a FHIR partner via the existing
  `ehr_fhir_tenants` machinery (no merge).
- **G15.** Optional shared SSO.

## Compliance / business (parallel, gates *signing* tenants)

- **G16.** You become a **Business Associate** to every tenant. The in-app
  HIPAA machinery was deliberately retired; hosting other companies' PHI
  brings it back as a **business/legal** workstream: a **BAA per tenant** and
  realistically **SOC 2**. The RLS backstop (`0348`) is already the evidence
  artifact reviewers expect. This gates *signing*, not *code*.

---

## Suggested sequencing

| Order | Item | Why first |
| ----- | ---- | --------- |
| 1 | **G1** storefront/customer host→org + **G2** worker fan-out | Without these a 2nd tenant cannot transact or be served at all. Highest blast radius. |
| 2 | **G3** per-tenant `app_config` | Unblocks per-tenant credentials that G5–G8 depend on. |
| 3 | **G4** platform super-admin console + impersonation | Operate/support tenants without SQL. |
| 4 | **G5–G8** Stripe Connect, email, telecom, payer creds | Per-tenant money/comms identity. Can parallelize across the four. |
| 5 | **G12** usage metering, **G10** subdomains, **G9** admin theme | Commercial + polish. |
| 6 | **G16** BAA/SOC 2 (start in parallel — long lead) | Gates signing, not shipping. |
| 7 | **G13–G15** CareMetric cross-linking | Loosely coupled; do when EMR integration is prioritized. |

Items 1–4 are the real "make it multitenant" tail; everything Phase 0
guaranteed (isolation safety) is already in place, so each of these is an
additive, independently shippable, single-tenant-correct change.

---

## Definition of done (operationally multi-tenant)

1. A second `organizations` row, given a verified domain, serves **its own**
   catalog, customers, orders, and branding — verified by an extended
   cross-tenant leakage/serving test on tenant B's host (G1).
2. Every recurring background job runs for **every active tenant** (G2).
3. Tenant-overridable config + credentials resolve per `org_id` (G3).
4. A platform super-admin can onboard, suspend, meter, and support tenants
   from a UI (G4, G12).
5. Each tenant bills, emails, and texts under its **own** identity (G5–G8).
6. A BAA + SOC 2 path exists for signing tenants (G16).
