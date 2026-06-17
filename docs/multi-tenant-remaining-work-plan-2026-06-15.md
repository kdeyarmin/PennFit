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
_isolation-ready single-tenant deployment_ into an _operationally
multi-tenant SaaS_ that can serve a second DME company end-to-end.

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

## Implementation progress (this branch, 2026-06-15)

Work landed on `claude/multitenant-migration-plan-alh7jy` so far:

- **G0 — audited** (see below). Corrected the coverage numbers; classified
  the 59 non-`org_id` tables; identified the genuine scope-candidates.
- **G1 — core landed.** `resolveOrgIdByHost()` (verified-custom-domain →
  `org_id`, fail-soft to seed, cached) + a shared `requestHost()` helper;
  `requireSignedIn` / `attachSignedIn` now resolve the tenant **by host**
  instead of always the seed org; `POST /api/orders` mirrors to the
  host-resolved tenant. 6 resolver unit tests; single-tenant behavior
  unchanged. **Remaining:** the HMAC signed-link storefront flows
  (`reminders.ts`, `csr-orders.ts`, `patient-packets.ts`) should derive
  `org_id` from the **token-referenced record**, not the host — a distinct
  sub-task (they're seed-correct for single-tenant today).
- **G2 — foundation + 11 crons landed.** `listActiveOrgIds()` (db package)
  and `forEachActiveOrg()` (worker lib, per-tenant error isolation), both
  unit-tested. Eleven internal-only crons converted across every
  structural shape (see the G2 "DONE" row below). **Remaining:** each
  remaining cron is classified in the G2 table as FAN-OUT (1 left,
  mechanical), SUITE-GATED (~24 patient-SMS/email/billing crons — need the
  Node-24 worker integration suite, per the cutover playbook), or
  KEEP-GLOBAL (~10 global-table sweeps — must not fan out).

The full `resupply-api` suite (5500+ tests) and the tenant-isolation guard
(baseline 0) stay green throughout.

## Independent verification audit + corrective fixes — 2026-06-17

A full independent re-review of the transition (every gate, read against the
working tree rather than the status table) found that the **2026-06-17 status
table below was materially over-optimistic**: several gates marked
"Done & merged" were **substrate-only** (the per-tenant resolver was written
and unit-tested, but the callsites were never converted), and the audit
surfaced **three real bugs the gap list never tracked**. The isolation
substrate itself (the `getOrgScopedClient` facade — all four verbs scoped,
forces `org_id` on writes, fails closed on a missing org) and G4/G10/G12 are
genuinely solid; the corrections are to the per-tenant **identity/serving**
claims.

**Corrected verdicts (what the table got wrong):**

- **G6 (per-tenant email From) — was substrate-only, not "merged".** Only 1
  of ~60 senders used `resolveTenantSender`; all patient email (reminders,
  order confirmations, auto-replies) went out from the platform
  `info@pennpaps.com` / "PennPaps".
- **G7 (per-tenant telecom) — inbound done, OUTBOUND was not.** Inbound
  SMS/voice/fax route by called number, but every outbound SMS/voice used the
  global Twilio number; `resolveTenantSmsFrom`/`resolveTenantVoiceFrom` were
  dead code and the voice bridge hardcoded the seed org.
- **G8 (per-tenant payer creds) — actively mis-billed.** `dme_organization`
  was read as an unscoped **singleton**, so every tenant's 837P/PAS was built
  under the **seed NPI/PTAN/tax-id**; the claim-submit path uploaded over the
  **seed SFTP** account (no per-tenant transport override). Credential
  resolution failed **open** (env→stub).
- **G2 — the SUITE-GATED list was both stale and incomplete.** Most listed
  crons were already fanned out, but ~9 patient-facing/clinical crons were
  seed-pinned at the **engine** layer and untracked (rx-renewal,
  smart-triggers, onboarding-checkins, coaching-auto-enroll, …).
- **New, untracked bugs:** (a) `patient-autopay-charge` **and**
  `payment-plan-autocharge` checked their feature flag **once globally** then
  fanned out — the seed tenant's flag authorized off-session card charges for
  **every** tenant; (b) six public storefront routes (`reviews`,
  `product-questions`, `product-compatibility`, `nps-response`, `order-pod`,
  `order`) resolved `resolveSeedOrgId()` on `org_id`-bearing tables, so
  tenant #2's data read/wrote the seed tenant.

**Corrective fixes landed on this branch
(`claude/charming-ramanujan-25rytd`):**

1. **Money flag (both autopay crons):** the `billing.patient_autopay` /
   `billing.payment_plan_autocharge` flag is now checked **per-org inside the
   fan-out**, so one tenant's flag can never authorize another's charges
   (regression tests added).
2. **Billing identity (G8 #1/#2):** `resolveBillingIdentity` /
   `resolveClearinghouse` now read `dme_organization` **org-scoped** and gate
   the env/seed fallback to the seed org only — a non-seed tenant without its
   own identity **fails closed** instead of billing under the seed NPI. The
   Office Ally submit path now injects the **tenant's own SFTP transport** and
   refuses to submit for an under-configured non-seed tenant. Migration
   **0375** relaxes the `dme_organization` singleton and
   `clearinghouse_credentials (slug, usage_indicator)` uniqueness to **per
   `org_id`** so a second tenant can be configured. Single-tenant behavior is
   unchanged (the seed row's `org_id` was backfilled in 0331/0341).
3. **Email From (G6):** patient-facing senders that know their `orgId`
   (reminders, conversation replies, inbound auto-reply, order confirmations)
   now send under the tenant sender, falling back to the platform default —
   via an app-side `applyTenantEmailSender` helper so the `resupply-reminders`
   lib keeps its layering. (Remaining: the hardcoded "PennPaps" brand string
   in order-confirmation body copy needs a tenant-brand lookup — a separate
   storefront-brand change, not the From identity.)
4. **Outbound telecom (G7):** the dead `resolveTenantSmsFrom` /
   `resolveTenantVoiceFrom` resolvers are now threaded through the outbound
   SMS/voice senders that have an `orgId` in scope, and the voice bridge
   carries the resolved tenant instead of the seed org.
5. **Crons (G2):** the untracked seed-pinned patient/clinical crons
   (rx-renewal-send, smart-trigger-send/evaluator, onboarding-checkins,
   coaching-auto-enroll) now fan out per active tenant with per-tenant flag
   checks. `referral-review-extract` is deferred (event-driven per-review;
   needs a job-payload `org_id` contract change).
6. **Storefront (G1):** the six seed-pinned public shop routes now resolve
   the tenant by host (`resolveOrgIdByHost`), seed only as last-resort
   fallback.

**Per-tenant email senders — now largely converted.** The patient-facing email
senders have been moved off the bare platform SendGrid client onto
`createTenantSendgridClient(orgId)` + per-tenant brand
(`resolveBrandingByOrgId`): the order-confirmation pair, the 12 `lib/order-emails`
lifecycle senders (winback, deductible-reset, delivery-followup, EOB-explainer,
insurance-estimate, lifecycle-touchpoint, quarterly-summary, quiz-results,
ready-for-pickup, shipping-notification, therapy-milestone, caregiver), the
storefront reminder + return-status emails, the smart-trigger and rx-renewal
dispatchers, the cart-abandonment / back-in-stock / appointment-assigned /
review-request senders, clinical-outreach, the checkin / patient-packet /
csr-order email paths, and the per-org lead/patient worker crons
(video-visit-reminders, recall, maintenance-nudges, fitter-supply-campaign,
fitter-lead-reengage / first-day-nudge, bulk-campaign-tick) plus the admin
video-visits / fitter-invites routes. Internal/ops/auth mail (password resets,
operator digests, DLQ/metric/integration alerts, CSR-inbox, review-moderation,
scheduled reports, the admin assistant) intentionally stays on the platform
From. _Remaining sender items:_ a few internal-vs-patient nuanced senders
(`storefront/orderEmail` fulfillment-to-practice, `insurance-lead-email`'s mixed
team+lead recipients), `statement-send`'s sync `practiceName` builder, and the
non-brand-copy bodies in a couple of large knowledge-base senders
(checkin day-copy); none affect a second tenant's From identity. Remaining
outbound-SMS callsites lacking an in-scope `orgId` are likewise a small tail.

**Still open after this branch (tracked):** the small sender/SMS tail noted
above. The G1 `reminder_subscriptions` global-table resolution is
now **addressed** — migration 0378 adds `org_id` to the public
`reminder_subscriptions` table (backfilled to seed) and re-keys email
uniqueness to `(org_id, email)` so two tenants can each enroll the same email;
the storefront subscribe records the host tenant, the admin list/send filter to
the caller's org, the order auto-enroll stamps the order's org (per-tenant
flag), and the unsubscribe copy resolves the subscription's own brand instead of
hard-coded "PennPaps" (manage/unsubscribe stay keyed by the globally-unique
token). The G8 read-only singleton consumers are now **addressed**:
`company-info` is org-aware (`getCompanyInfo(orgId)` / `getDocumentSupplierName(orgId)`
with a per-org cache; the seed/sync path is unchanged), and the patient-facing
DME document callers thread their `orgId` (PA requests, CMN/DWO/SWO,
prescription requests, compliance attestations, patient-payment descriptors);
`dispense-readiness` reads org-scoped (the redundant `singleton` filter is
gone); and the GFE issuer block was already org-scoped via the
`resolveBillingIdentity` fix. _Remaining within G8:_ `statement-send`'s
`practiceName` comes from a sync env-config builder with no `orgId` (still the
seed/platform default — no regression; a deeper async threading job). The
order-confirmation brand
string is now **addressed** — both order-confirmation emails resolve the
tenant's storefront name via `resolveBrandingByOrgId(orgId)` (seed → "PennPaps",
unchanged; a second tenant → its own brand). The G16
seed-org BAA grandfather row is now **addressed** (migration 0376 seeds the
seed org's `baa` + `platform_terms` acceptances at the current versions,
`ON CONFLICT DO NOTHING`, so deploying the gate no longer locks the existing
admin out; new tenants still sign via the UI, and a future version bump still
re-prompts). **The
billing-identity change (item 2) is unit-tested but should be
integration-verified against a real PostgREST/DB before a second tenant
transmits live claims.**

## Status refresh — 2026-06-17

The gap list below was written on 2026-06-15; nearly all of it has since
shipped and merged. **This section is the current source of truth**; the
detailed per-gap prose further down is kept for context but is no longer
the live status. _(Superseded in part by the **Independent verification
audit** section above — where they disagree, the audit is correct: G6, G7
outbound, and G8 were substrate-only/mis-billing, not fully done.)_

**What changed since the 2026-06-16 refresh:** G10 (subdomain routing),
G12 (per-org usage metering), and G16 (BAA gate) have all **merged to
`main`** — they were "in review" on 2026-06-16. All five G12 metrics are
now wired, including `outboundMessagesPerMonth` across the patient-comms
senders; the last two **order-confirmation** senders are metered in review
(#1069), which closes G12 (see the G12 row). G9 (per-tenant brand
**colors**) has been **decided as a
non-goal** by product: the platform keeps a consistent admin/storefront
theme across tenants on purpose, so only logo/name/tagline stay
per-tenant. A `tenant:offboard` CLI also landed alongside `tenant:onboard`.
Net result: every load-bearing gap (G0–G8) plus the commercial/routing
layer (G10, G12, G16) is done (G12's last two senders are metered in
review, #1069); the remaining code items are the G1 signed reminder-link
tenant resolution, optional/later items (G11, G13–G15), and the
cron-fan-out session's SUITE-GATED tail.

| Gap         | What it is                                   | Status (2026-06-17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0**      | `org_id` coverage on tenant tables           | **Done.** The 2026-06-15 "genuine candidates" (`education_videos` → migration 0358; `providers`, `provider_portal_accounts`, `product_costs`, `control_number_counters`, `object_storage_acls`, `metric_alerts`/`metric_thresholds`, `payer_estimate_stats`, …) all carry `org_id` and are reached through the org-scoped `.from()` facade. The intentionally-global set (catalogs, infra, the directory itself) stays `.raw()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **G1**      | Storefront/customer served by host, not seed | **Done.** `resolveOrgIdByHost()` + `requireSignedIn`/`attachSignedIn` resolve the tenant by host; `customerIdResolver`/`ensureShopCustomerRow` thread the host org; cross-tenant **serving** test is `middlewares/requireSignedIn.tenant-host.test.ts`. _Remaining:_ encode `org_id` into HMAC signed reminder links so a click-through lands in the right tenant — coupled to the reminders sender, owned by the cron-fan-out workstream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **G2**      | Crons run per active tenant                  | **Largely done.** Fan-out primitives + the internal-only and patient-comms crons (with two-org integration tests) shipped (#988–#998, #1024). The SUITE-GATED tail is owned by the concurrent cron-fan-out session. KEEP-GLOBAL sweeps stay single-client by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **G3**      | Per-tenant `app_config`                      | **Done.** `(org_id, key)` PK (migration 0352); `getTenantConfigValue(orgId, key)` request-scoped reader with seed fallback; catalog split into platform-global vs `scope: "tenant"`; `/admin/system/configuration` writes the caller's org.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **G4**      | Platform super-admin surface                 | **Done.** `platform_admins` (0355), `requirePlatformAdmin`, `/platform/*` console (tenants, billing, impersonation), and audited act-as-tenant impersonation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **G5**      | Stripe Connect                               | **Done & merged** (Express onboarding + `charges_enabled` gate, #1019–#1022).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **G6**      | Per-tenant email From                        | **Done & merged** (`organizations.from_email`/`from_name`, 0360; `resolveTenantSender`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **G7**      | Per-tenant telecom                           | **Done & merged** (inbound SMS/voice routed to the tenant by called number, #1022).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **G8**      | Per-tenant payer creds                       | **Done** (org-scoped clearinghouse creds, fail-closed reads).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **G9**      | Admin/storefront theme from org branding     | **Non-goal (product decision, 2026-06-17).** Logo/name/tagline stay per-tenant; brand **colors** deliberately do **not** vary — the platform keeps a consistent theme across tenants. No per-tenant color columns/UI will be built. (Was previously "the one remaining real feature.")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **G10**     | Subdomain routing (`<slug>.<base>`)          | **Done & merged (#1027).** `extractTenantSubdomainLabel` + slug resolution in both host resolvers + CORS; `PLATFORM_SUBDOMAIN_BASES`. No migration (`organizations.slug` already exists).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **G11**     | Self-serve onboarding                        | Not built (optional; `tenant:onboard` CLI + G4 console cover operations).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **G12**     | Per-org usage metering                       | **Merged — all five metrics wired; one wire-up remaining.** Emitter writes `tenant_usage_monthly_rollups` via an atomic-increment RPC (migration 0367); the platform billing console reads the rollup (#1025). Metrics: `aiTextInteractionsPerMonth`, `billingTransactionsPerMonth`, `faxEvents`, `aiVoiceEvents`, and `outboundMessagesPerMonth` — the last via a shared `recordOutboundMessageUsage` helper across the patient-comms senders (reminders, campaigns, nudges, invites, conversation replies), on confirmed delivery, internal ops/auth mail excluded (#1038, #1046, #1049, #1052). The two patient-facing **order-confirmation** emails (`sendFitterOrderConfirmationEmail` in `routes/storefront/orders.ts`, `sendOrderConfirmationEmail` in `lib/stripe/webhook-handler.ts`) are metered in review (#1069) — product call resolved as "transactional confirmations count" — which completes the metric across every patient-facing send. |
| **G13–G15** | CareMetric cross-linking                     | Not started (later/optional).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **G16**     | BAA per tenant (SOC 2 out of band)           | **Done & merged (#1023).** `organization_agreements` (0366) + onboarding gate; enforced **server-side** in `requireAdmin` (not just the SPA). SOC 2 remains a business workstream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Net:** the load-bearing tail (G0–G8) **and** the commercial/routing layer
(G10, G12, G16) are merged (G12's last two order-confirmation senders are
metered in review, #1069). G9 is a **product non-goal** (consistent theme
by design). The remaining code items are narrow: (a) the **G1** signed
reminder-link tenant resolution — the `/api/reminders/manage` click-through
still resolves the seed org and reads the global `reminder_subscriptions`
table (`routes/storefront/reminders.ts`), coupled to the reminders sender
workstream; and (b) the **G2** SUITE-GATED cron tail owned by the
cron-fan-out workstream. Neither blocks a second tenant from being served,
transacting, or billing; (a) affects tenant-correct reminder routing.

## The load-bearing gaps (must-fix before a 2nd tenant goes live)

These are the items that make the difference between "isolation-ready" and
"actually serves tenant #2." They are ordered by how badly they block a
real second customer.

### G0. Confirm `org_id` coverage is complete — **correctness audit** ✅ _audited_

**Audited 2026-06-15.** Of 212 `resupply` tables, **153 carry `org_id`**
and **59 do not**. (An earlier inventory said only 37 — it missed
migrations `0341`/`0342`, which scoped the long tail; several "candidates"
it flagged — `locations`, `outreach_playbooks`, `webhook_subscriptions`,
`gl_account_mappings` — in fact **already have** `org_id`.) The chokepoint
auto-appends `.eq("org_id", …)`, so a table _without_ the column queried
via `.from()` would **error** — meaning the 59 are already, by
construction, reached via `.raw()` as deliberately-global. The audit
classified the 59:

- **Retired no-op stubs (do NOT scope)** — the migration-0156 compliance
  tables (`accreditation_*`, `business_associate_agreements`, `hipaa_*`,
  `oig_leie_*`, `patient_grievances`, `patient_rights_requests`,
  `staff_training_records`, `quality_improvement_*`, …) and `audit_log`.
- **Legitimately global** — reference catalogs (`hcpcs_codes`,
  `denial_codes`, `product_hcpcs_map`, `sku_hcpcs_map`), infra
  (`idempotency_keys`, `worker_dedup_keys`, `worker_run_summary`,
  `fhir_jwt_jti_seen`, `inbound_webhooks`, `stripe_webhook_events`), and
  the directory itself (`organizations`, `ehr_fhir_tenants`).
- **Genuine candidates to scope (Phase 2 / G12 work)** —
  `control_number_counters` (EDI sequences must not collide across
  tenants), `object_storage_acls` (PHI attachment access), the
  `inbound_referral_*` pipeline, `appointment_requests`, the analytics
  rollups (`metrics_daily`, `therapy_fleet_daily_metrics`,
  `payer_estimate_stats`, `metric_alerts`, `metric_thresholds`),
  `providers` / `provider_portal_accounts` / `providers_pecos_status`,
  `product_costs`, `education_videos`.

**Remaining work:** add `org_id` (a `035x` migration) to the genuine
candidates and cut over their (mostly `.raw()`) callsites. Most are not
on a tenant-serving hot path today (billing EDI, analytics, provider
networks), so they're sequenced with the Phase 2 / metering work, not the
G1/G2 blockers.

### G1. Public storefront + customer portal data is pinned to the seed org — **blocker**

`requireSignedIn` and every `routes/storefront/*` handler resolve the
tenant with `resolveSeedOrgId()`, not by host:

- `artifacts/resupply-api/src/middlewares/requireSignedIn.ts:152` —
  `req.orgId = (await resolveSeedOrgId())` with the comment
  _"Single-tenant today → the seed org; later reads shop_customers.org_id."_
- `routes/storefront/{orders,reminders,csr-orders,...}.ts` all call
  `resolveSeedOrgId()` directly.

Branding resolves by host (`resolveBrandingByHost`) but **data does not**.
A second tenant's storefront would render their logo over PennPaps'
catalog, customers, and orders.

**Work:**

1. ✅ Add `resolveOrgIdByHost(host)` next to `resolveBrandingByHost` (reuse
   the same verified-`custom_domain` → `organizations.id` lookup + cache).
   **Done** — `req.orgId` now resolves by host in `requireSignedIn` /
   `attachSignedIn`, and `POST /api/orders` mirrors to it.
2. **Make the customer-row resolution org-aware (remaining).** `req.orgId`
   now switches to the host tenant, but the **customer identity** is still
   seed-pinned: `customerIdResolver` (in `lib/auth-deps`) and
   `ensureShopCustomerRow` (used across ~10 patient-portal routes) build a
   **seed-org** scoped client. So a first-time signed-in tenant shopper
   gets/creates a _seed_ `shop_customers` row while `/shop/me` and order
   code read tenant-scoped tables via `getOrgScopedClient(req.orgId)` —
   profile updates can no-op and returned data can mix tenants. This is
   **single-tenant-correct today** (all hosts → seed, so the two agree),
   but must be fixed before tenant #2: resolve org **before** the customer
   lookup and thread the host-resolved `orgId` through `customerIdResolver`
   / `ensureShopCustomerRow`. (Flagged by review on PR #969.)
3. Replace remaining `resolveSeedOrgId()` in the **signed-link**
   `routes/storefront/**` flows (`reminders`, `csr-orders`,
   `patient-packets`) with a **token-derived** org (the link/record's
   tenant), not the host. Keep seed fallback **only** for the apex
   `pennfit.up.railway.app` host so single-tenant stays correct.
4. Signed patient links (SMS/email reminders via `RESUPPLY_LINK_HMAC_KEY`)
   must encode/resolve `org_id` so a click-through lands in the right
   tenant — audit `lib/resupply-reminders` + the link verifier.
5. Extend the cross-tenant leakage test to cover a storefront/customer
   request on tenant B's host.

### G2. Scheduled worker jobs only process the seed org — **blocker**

The cutover scoped _job bodies_ correctly, but the _schedulers_ resolve a
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

**Progress + the executable remainder.** The fan-out primitives
(`listActiveOrgIds`, `forEachActiveOrg`) are landed and tested, and **11
crons are converted** as the proven template across every structural
shape: `conversation-orphan-assignee-sweep`, `prior-auth-expiry-sweep`,
`sla-escalation-sweep`, `asset-recovery-auto-populate` (feature-gated),
`patient-documents-retention-sweep`, `therapy-integrations-nightly-sync`,
`bill-hold-sweep`, `dwo-expiry-sweep`, `coaching-plan-progress`,
`prescription-request-auto-draft`, `fitter-conversion-attribution`. Every
remaining cron is classified below — the audit found that several
"obvious" candidates sweep **global rollup tables that have no `org_id`**
(`metrics_daily`, `therapy_fleet_daily_metrics`, `providers*`,
`webhook_*`) and must **not** fan out until those tables are scoped (G12),
and that four sweeps first assumed internal actually **send patient
email** (`lapsed-customer-winback`, `quarterly-therapy-summary`,
`lifecycle-touchpoints`, `therapy-milestones`) so they move to
SUITE-GATED.

**Update 2026-06-16 — the SUITE-GATED tier is now executable and in
progress.** The "Node-24 worker integration suite" the SUITE-GATED row
waited on **exists**: each fanned-out patient-comms cron ships a real-
PostgREST `*.integration.test.ts` (env-gated skip; seeds **two** orgs and
asserts no cross-tenant send), wired into the CI **Integration (PostgREST)**
job alongside `invite-password-expiry-notify`. Landed on this pattern so
far: `maintenance-nudges` (#988), `video-visit-reminders` (#991),
`recall-notifications-send` (#993), `patient-packet-reminders` (#997), and
`reminder-escalation` (#996); `clinical-outreach-batch` +
`eligibility-reverify-batch` are in flight (#998). Also corrected:
`prescription-attachment-sweep` is **not** a fan-out candidate — after its
global-read fix (#980) it reads referenced storage keys across **every**
tenant via `.raw()` (the bucket is shared, so a blob is an orphan only if
no tenant references it). Fanning it out per tenant would re-scan globally
N times and risk deleting another tenant's PHI; it is **KEEP-GLOBAL**.

| Disposition                                                                                                                                                                                                                                                     | Crons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Action                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DONE** — fan-out + tests landed                                                                                                                                                                                                                               | _Internal-only (original 11):_ `conversation-orphan-assignee-sweep`, `prior-auth-expiry-sweep`, `sla-escalation-sweep`, `asset-recovery-auto-populate`, `patient-documents-retention-sweep`, `therapy-integrations-nightly-sync`, `bill-hold-sweep`, `dwo-expiry-sweep`, `coaching-plan-progress`, `prescription-request-auto-draft`, `fitter-conversion-attribution`. _Patient-comms (with real-DB integration tests):_ `maintenance-nudges` (#988), `video-visit-reminders` (#991), `recall-notifications-send` (#993), `patient-packet-reminders` (#997), `reminder-escalation` (#996)                       | ✅ fan-out + tests landed.                                                                                                                          |
| **IN FLIGHT**                                                                                                                                                                                                                                                   | `clinical-outreach-batch`, `eligibility-reverify-batch` (#998)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Wrapper-only fan-out (run cores already take `{ orgId }`).                                                                                          |
| **SUITE-GATED FAN-OUT** (remaining) — tenant-scoped, **sends SMS/email or charges cards**; the integration-suite harness now exists, so each follows the #988 template. `reminders`/`bulk-campaign-tick` ALSO need pg-boss payload `org_id` threading (do last) | `reminders`, `cart-abandonment-scan`, `low-stock-alerts` (also needs per-tenant Stripe/recipients — G5/G3), `therapy-fleet-alerts-scan`, `shop-order-delivery-followup`, `lapsed-customer-winback`, `quarterly-therapy-summary`, `lifecycle-touchpoints`, `therapy-milestones`, `fitter-lead-first-day-nudge`, `fitter-lead-reengage`, `fitter-supply-campaign`, `outreach-playbook-tick`, `patient-autopay-charge`, `payment-plan-autocharge`, `bulk-campaign-tick`, `office-ally-inbound-poll`, `pacware-ready-to-sync-digest`, `auto-submit-batch` (engine resolves seed internally — deeper than a wrapper) | Same fan-out + a two-org integration test; thread `org_id` through any enqueue→process payloads.                                                    |
| **KEEP GLOBAL** — sweeps a **global** table (no `org_id`); must stay single-client (do _not_ fan out)                                                                                                                                                           | `idempotency-keys-prune`, `webhook-dispatcher`, `pecos-sync`, `metrics-snapshot`, `metric-alerts-evaluator`, `metric-alerts-notify`, `therapy-fleet-daily-snapshot`, `owner-digest`, `failed-order-emails-digest`, `invite-password-expiry-notify`, **`prescription-attachment-sweep`** (global-bucket janitor — reads referenced keys across all tenants via `.raw()`; #980)                                                                                                                                                                                                                                   | Leave as-is; add a one-line "global sweep — single client by design" comment. Several become FAN-OUT only **after** G12 scopes their rollup tables. |

### G3. `app_config` is still a global singleton — **blocker for credentials**

`app_config` has an `org_id` column (`0336`) but the reader/store
(`lib/app-config/{store,catalog}.ts`) treats it as a **single global row
per key** and folds values into `process.env` at boot. So every tenant
shares one `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `AIRVIEW_CLIENT_ID`,
assistant names, etc. (Assistant _names_ are per-tenant only by accident
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

**Work:** Stripe **Connect**. Store `stripe_account_id` on
`organizations`; route Checkout/PaymentIntents with `stripeAccount`;
optional application fee (`application_fee_amount`) for platform revenue
share; per-account webhook routing (resolve `org_id` from the Connect
account id). Seed catalog/products become per-tenant.

**Slice 1 (done, migration 0359 +
`artifacts/resupply-api/src/lib/stripe/connect.ts`):** the routing
substrate. `stripe_account_id` column (nullable, inert), the outbound
`stripeAccountRequestOptions(orgId)` resolver and the inbound
`resolveOrgIdByConnectedAccount(accountId)` reverse-lookup for webhooks.
A tenant only switches onto Connect once an operator populates the column.

**Slice 2 (future): onboarding = Express accounts.** The account-link /
onboarding flow that actually populates `stripe_account_id` uses Stripe
**Express** connected accounts (not Standard): the platform owns the
onboarding UX via hosted **Account Links**, keeps dashboard/branding under
the platform, and can attach an application fee for revenue share — the
right fit for DME tenants who shouldn't manage a full Standard Stripe
dashboard. Build: create the Express account, generate an Account Link for
the tenant admin, persist the returned `acct_…` on populate (calling
`invalidateStripeConnectCache()`), and gate go-live on
`charges_enabled` / `details_submitted` from the account's status.

### G6. Per-tenant email From address

The **"one From address" hard rule** (`info@pennpaps.com`, enforced in
`createSendgridClient()` + `preflight:prod`) must become **one From address
_per tenant_**. This is a deliberate, documented relaxation of a current
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

### G9. Admin theme driven by org branding — **non-goal (product decision, 2026-06-17)**

**Decision:** brand **colors** will not be per-tenant. The platform keeps a
single consistent admin/storefront theme across all tenants on purpose;
only logo, name, and tagline are tenant-specific. The original idea —
driving the admin tokens (`--penn-navy`, etc., in `src/admin.css` under
`.admin-root`) from per-tenant branding — is **shelved, not deferred**. If
this is ever revisited, the **hard rule** still stands: re-point only the
**raw** `--background` / `--foreground` vars under `.admin-root`, never add
a global `@theme` block (see `admin.scope.test.ts`).

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
  `org_id`-scoped usage metering _in Phase 0 so billing isn't retrofitted_
  — this was **not** built. Add a metering table (active patients / messages
  / orders per org per period) and a rollup the platform console reads.
  Needed before per-active-patient pricing.

## Phase 4 — CareMetric cross-linking (later, optional)

- **G13.** Deep links between the CareMetric EMR and Resupply.
- **G14.** Wire the EMR as a FHIR partner via the existing
  `ehr_fhir_tenants` machinery (no merge).
- **G15.** Optional shared SSO.

## Compliance / business (parallel, gates _signing_ tenants)

- **G16.** You become a **Business Associate** to every tenant. The in-app
  HIPAA machinery was deliberately retired; hosting other companies' PHI
  brings it back as a **business/legal** workstream: a **BAA per tenant** and
  realistically **SOC 2**. The RLS backstop (`0348`) is already the evidence
  artifact reviewers expect. This gates _signing_, not _code_.

---

## Suggested sequencing

| Order | Item                                                           | Why first                                                                                    |
| ----- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0     | **G0** `org_id` coverage audit                                 | Cheap, and it confirms the isolation guarantee has no missing-column holes before tenant #2. |
| 1     | **G1** storefront/customer host→org + **G2** worker fan-out    | Without these a 2nd tenant cannot transact or be served at all. Highest blast radius.        |
| 2     | **G3** per-tenant `app_config`                                 | Unblocks per-tenant credentials that G5–G8 depend on.                                        |
| 3     | **G4** platform super-admin console + impersonation            | Operate/support tenants without SQL.                                                         |
| 4     | **G5–G8** Stripe Connect, email, telecom, payer creds          | Per-tenant money/comms identity. Can parallelize across the four.                            |
| 5     | **G12** usage metering, **G10** subdomains, **G9** admin theme | Commercial + polish.                                                                         |
| 6     | **G16** BAA/SOC 2 (start in parallel — long lead)              | Gates signing, not shipping.                                                                 |
| 7     | **G13–G15** CareMetric cross-linking                           | Loosely coupled; do when EMR integration is prioritized.                                     |

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
