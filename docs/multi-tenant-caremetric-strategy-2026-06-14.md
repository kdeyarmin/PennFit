# Multi-Tenant SaaS Strategy: Leasing PennFit under the CareMetric AI Brand

**Date:** 2026-06-14
**Status:** Strategy / direction-setting (no code committed yet)
**Decisions locked in this doc:**

- **Isolation model:** Pooled multi-tenancy — one Supabase project, `org_id`
  on every tenant-scoped row, RLS as a defense-in-depth backstop.
- **CareMetric relationship:** Loosely coupled — PennFit and the existing
  CareMetric EMR stay as separate products that cross-link, rather than
  merging databases or UI shells.
- **Deliverable:** This shareable one-pager (partner / investor / internal
  alignment).

> This is a planning document. It deliberately does **not** change the
> running single-tenant system. It is the reference the eventual
> phase-by-phase engineering plan will be cut from.

---

## 1. The opportunity

PennFit is today a single-tenant CPAP/DME resupply platform running one
company (Penn Home Medical Supply, `pennpaps.com`). The same engine —
patient resupply automation, voice/SMS/email outreach, claims + clearinghouse
billing, an admin console, and an AI assistant layer — is exactly what other
DME companies pay for and mostly do badly. Leasing it as **CareMetric AI
Resupply** turns a cost center (one company's internal tooling) into a
recurring-revenue SaaS product, and gives the CareMetric brand a second
module alongside the EMR you already own.

The strategic bet: **CareMetric becomes a family of loosely-coupled DME
products** (EMR + Resupply, more later) that share a brand, a sales motion,
and a customer, but not a monolith.

---

## 2. Why this is achievable (the architecture is already pointed here)

PennFit was built single-tenant but with the door left open. Concretely:

- **`dme_organization` is a singleton with a code comment stating the
  singleton flag is meant to be dropped "for multi-tenant evolution."** The
  org concept already exists; it just needs to go from one row to many.
- **A `locations` table already exists** (migration 0235) with nullable
  `location_id` on `patients` and `admin_users`, and `req.adminLocationId`
  already flows through the auth middleware. The scoping *pattern* is
  half-built.
- **Row-Level Security is already enabled** on every `resupply` /
  `resupply_auth` table (migration 0170), with `anon`/`authenticated` grants
  revoked. No policies exist yet only because the app uses the `service_role`
  client, which bypasses RLS. The framework is live and waiting.
- **One clean data path** (`getSupabaseServiceRoleClient()`), one auth
  system, one config surface. Authorization already lives in the application
  layer — exactly where tenant scoping belongs.

The honest gaps (each is tracked as a phase in §5):

1. No `org_id` exists yet — ~80–100 tables need a tenant anchor.
2. Auth scopes by *role* (what you can do), not by *tenant* (whose data you see).
3. Feature flags and `app_config` are global single rows.
4. Branding, email From address, and Stripe credentials are single-valued.
5. One public domain per deploy; no host→tenant routing.

---

## 3. The isolation model: pooled + RLS

All tenants live in one Supabase project. Every tenant-scoped row carries an
`org_id`. Isolation is enforced in **two independent layers**:

1. **Application layer (the real guarantee).** A mandatory scoped
   query-builder wrapper injects `org_id` into every read and write. Because
   the `service_role` key bypasses RLS, this app-layer filter — not RLS — is
   what actually keeps tenants apart. Making it a single chokepoint means we
   secure ~100 routes by securing one wrapper, instead of auditing each route
   by hand.
2. **Database layer (defense-in-depth).** RLS policies keyed on a
   request-scoped `org_id` setting act as a backstop and as the artifact that
   security reviewers and BAAs expect to see.

**Why pooled over schema-per-tenant or DB-per-tenant:**

| Model | Isolation | Ops cost | Verdict |
| --- | --- | --- | --- |
| **Pooled + RLS (chosen)** | Logical (app + RLS) | Low — one DB, one deploy, one migration run | Best fit: matches existing single-deploy/service-role design; fastest onboarding |
| Schema-per-tenant | Stronger | Medium — migrations fan out across N schemas | Unneeded complexity at current scale |
| DB/project-per-tenant | Physical | High — N credential sets, N migration runs | Reserve as a future premium "dedicated instance" tier for a security-demanding whale |

Pooled is the standard healthcare-SaaS pattern and the least-rework path from
where the code is today. A dedicated-instance tier can be layered on later for
a customer who contractually requires physical isolation, without changing the
pooled default.

---

## 4. The CareMetric relationship: loosely coupled

PennFit (as CareMetric AI Resupply) and the existing CareMetric EMR remain
**separate products that cross-link** — not a merged database or a single UI
shell. This keeps blast radius small, lets each product ship independently,
and lets you sell EMR-only, Resupply-only, or both.

What "loosely coupled" means concretely:

- **Shared brand, separate apps.** Both wear CareMetric AI branding and
  pricing/sales motion. Each runs as its own service.
- **Cross-linking, not co-mingling.** Deep links between the two
  ("open this patient's resupply" / "open this patient's chart"). No shared
  schema, no shared write path.
- **Optional light data exchange via the integration layer you already
  have.** PennFit already ingests SMART-on-FHIR bundles and tracks EHR
  partners in `ehr_fhir_tenants`. CareMetric EMR can be wired as *one of
  those FHIR partners* to push demographics/clinical context into resupply —
  reusing existing machinery rather than building a merge.
- **Shared sign-in is a later, optional nicety**, not a prerequisite. If/when
  desired, add SSO so a CareMetric customer logs in once. Until then, two
  logins under one brand is acceptable and far cheaper.

This deliberately avoids the heavy lifts (unified shell, shared patient
master, one invoice) in favor of shipping a leasable product sooner.

---

## 5. Phased roadmap

Each phase is independently shippable. Phase 0 carries the engineering risk;
everything after is comparatively mechanical.

### Phase 0 — Tenancy foundation (the unavoidable core)
- Evolve `dme_organization` into an `organizations` table; drop the singleton
  constraint; backfill existing data as org #1 (Penn Home Medical Supply).
- Add nullable `org_id` to tenant-scoped tables in **domain batches**
  (patients → orders → billing → comms…), backfill to org #1, then enforce
  `NOT NULL`. Not one giant migration.
- Add `org_id` to `admin_users` / sessions so the signed-in user carries a
  tenant.
- Build **tenant-context middleware** (`req.orgId`) and a **scoped Supabase
  wrapper** that refuses to build a query without an `org_id` filter.
- Write RLS policies keyed on a request-set `org_id` as the backstop layer.
- Add a CI **tenant-isolation check** (in the spirit of the existing
  `check-resupply-architecture.sh`) asserting every route goes through the
  scoped wrapper.

### Phase 1 — Per-tenant config & branding
- Move feature flags and `app_config` to an `(org_id, key)` shape so each DME
  toggles features independently.
- Make branding org-scoped (it already lives in `dme_organization` — just
  un-singleton it): logo, colors, legal name, NPI/PTAN, phone.
- Drive admin theming from org branding instead of hardcoded Penn navy/gold
  (the `.admin-root` scoping already isolates it cleanly).

### Phase 2 — Per-tenant external identity
- **Stripe → Stripe Connect:** each DME connects their own Stripe account;
  optional application fee gives you a clean revenue share.
- **Email:** per-tenant From address via SendGrid subusers / authenticated
  sending domains. (This intentionally relaxes the current "one From address"
  rule to "one From address *per tenant*.")
- **Telecom:** per-tenant Twilio numbers / subaccounts for SMS + voice.
- **Clearinghouse:** add `org_id` to `clearinghouse_credentials` (already
  multi-row) so each DME bills under its own Office Ally/Availity creds + NPI.

### Phase 3 — Routing & onboarding
- **Host→tenant routing:** subdomains (`acme.caremetric.ai`) and/or custom
  domains per tenant via Cloudflare; resolve `org_id` from the `Host` header.
- **Tenant provisioning flow:** create org → seed config/flags → bootstrap
  first admin → assign domain.
- **Platform super-admin console** (above tenant admins) for you to manage
  tenants, billing, and usage.

### Phase 4 — CareMetric cross-linking (loosely coupled)
- Deep links between EMR and Resupply.
- Wire CareMetric EMR as a FHIR partner via the existing integration layer.
- Optional shared SSO when justified.

---

## 6. Commercial model (decide early — it shapes Phase 0)

- **Pricing:** DME software typically lands on **per-active-patient** or
  tiered platform fees rather than per-seat. Whatever the choice, build
  **`org_id`-scoped usage metering into Phase 0** so billing isn't retrofitted.
- **Payments revenue share:** Stripe Connect application fees give automatic
  revenue share if you also process tenants' card payments.
- **Packaging:** EMR-only, Resupply-only, or bundled CareMetric suite.

---

## 7. Compliance & risk (start in parallel with Phase 0, not after)

- **You become a Business Associate to every tenant.** PennFit deliberately
  retired its in-app HIPAA machinery ("handled out of band by the business
  owner") — that assumption breaks the moment you host *other* companies'
  PHI. You will need a **BAA with each tenant** and, realistically, **SOC 2**
  to close deals. This is a business/legal workstream that gates *signing*
  tenants regardless of code readiness.
- **Cross-tenant PHI leakage is the single scariest failure mode.** Mitigated
  by: mandatory scoped-query wrapper + RLS backstop + automated isolation
  test (§5, Phase 0).
- **The `org_id` backfill** across ~100 tables is the largest engineering
  risk; sequence it behind the existing migration ledger and deploy gating.

---

## 8. Recommended next step

Approve this direction, then commission the **Phase 0 engineering plan** — a
file-level sequence covering the `organizations` migration, the
tenant-context middleware, the scoped query wrapper, the RLS policies, and
the CI isolation check. Phase 0 is the gate; once it lands, Phases 1–4 are
largely configuration and packaging work.
