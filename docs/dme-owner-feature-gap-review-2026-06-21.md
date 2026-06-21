# DME-Owner Feature & Function Gap Review — 2026-06-21

**Audience:** Penn Home Medical Supply ownership + engineering.
**Question asked:** _"Perform a comprehensive review and identify any feature
or function gaps that would be necessary or favorable for this type of software
to the DME owners."_
**Method:** Full code-verified inventory of the admin console (~170 admin
routes / ~145 pages), the billing/RCM + EDI stack, the resupply engine + ~70
worker jobs, the patient storefront/portal, and the integrations layer — then
**direct code verification of every candidate gap** before listing it. Cited as
`path` / `migration` evidence. Benchmarked against current DME-resupply
practice (Brightree ReSupply, WellSky/S3, NikoHealth) and the VGM Total Sleep
Services bureau model.

> This review is deliberately **additive** to the recent reviews — it does not
> re-derive them. See [`feature-gaps-analysis-2026-06-14.md`](./feature-gaps-analysis-2026-06-14.md)
> (built-but-dormant levers), [`backlog-reconciliation-2026-06-18.md`](./backlog-reconciliation-2026-06-18.md)
> (DONE/OPEN ledger), and [`complete-domain-review-2026-06-20.md`](./complete-domain-review-2026-06-20.md)
> (correctness/bug audit, mostly fixed). This doc is the **owner-facing feature
> gap map**, not a bug audit.

---

## Headline

**CareMetric Breathe is not short on features.** By any DME-resupply benchmark
it is one of the most complete platforms in the category — it already ships, in
code, the things competitors sell as premium add-ons: real-time 270/271
eligibility, 276/277 claim status, 837P batch submit + 835/ERA auto-posting,
AI claim scrubbing + denial analysis, capped-rental modifier rotation, Da Vinci
PAS prior auth, secondary/COB generation, outbound fax for PA/appeals, patient
autopay + payment plans, lapsed-customer win-back, the privacy-first on-device
mask fitter, an omnichannel inbox, and a three-vendor AI voice/SMS/email stack.

**Two findings dominate, and neither is "build more":**

1. **The biggest revenue/denial levers are activation decisions, not
   engineering** — several high-value programs are built and fail-soft but
   shipped behind feature flags / crons that default OFF (see Lens A).
2. **Naive "what's missing" scans over-state the gaps.** Verified this session:
   AOB, ABN, and Proof-of-Delivery were reported "not implemented" by one
   sub-scan — **all three ship and are mature**
   (`lib/resupply-db/migrations/0417_abn_acknowledgement_hcpcs_scope.sql`,
   `0106_patient_form_acknowledgements.sql`,
   `0111_shop_orders_pod_photo.sql`, `routes/shop/order-pod.ts`,
   `lib/paperwork/require-signed-paperwork.ts`, claim-paperwork gate
   `0248`/`0253`). The 06-18 doc's "unbounded revenue read" in
   `worker/jobs/metrics-snapshot.ts` is now **bounded to one day per org**.
   The genuinely-open list below is short and specific.

The genuinely-open, owner-favorable gaps cluster in **fulfillment last-mile
automation**, **a handful of RCM automation/accuracy items**, and the larger
**growth ceiling** (multi-location, referral-source development). The two
highest-leverage low-risk items were **implemented in this PR** (see
"Shipped in this PR").

---

## Gap map — by the four owner lenses

Status legend: **OPEN** (not built) · **PARTIAL** (built, loop not closed) ·
**DORMANT** (built, off by flag/cron — an activation decision) · **DONE** (for
contrast / "don't rebuild").

### Lens A — Recurring resupply revenue

| Capability                                         | Status              | Evidence                                                                                                                                                                                                                                                                                       | Owner impact                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resupply-due → order/draft action**              | **OPEN — #1 lever** | `routes/admin/therapy-resupply.ts` lists due/overdue device-driven items (summary / opportunities / CSV) with **no "create order" action**                                                                                                                                                     | The "who's due" worklist is read-only; every order is a manual hand-off. Converting it to one-click (entitlement-gated, queued for CSR review) is the single biggest recurring-revenue lever. |
| **Built-but-gated lifecycle / enforcement levers** | **DORMANT (mix)**   | See the **Activation state** table below — auto-reminder enrollment, the cart-abandonment dispatcher, email auto-reply, and claim auto-submit are already **ON** (migrations 0325 / 0149); the three enforcement flags + autopay + the voice tier + the cart/review recurring crons remain off | Highest-ROI remaining work is a **consent/staffing decision**, not engineering.                                                                                                               |
| **Membership / subscription tier (cash-pay)**      | **PARTIAL**         | `routes/admin/shop-membership.ts` — CSR-set only; Stripe subscription webhooks never reconcile `membership_tier`; no storefront join flow                                                                                                                                                      | Recurring cash-pay revenue + retention left on the table; a lapsed sub keeps its tier forever.                                                                                                |
| **Voice escalation tier (AI check-in call)**       | **DORMANT**         | built + flag-gated `reminder_escalation.voice` (migration 0395), seeded **OFF**; flips ON to make the reminder ladder SMS → email → **voice** → CSR, inside the patient's 9am–8pm local window                                                                                                 | Multi-channel cadence is how vendors lift connection ~15% → ~45%.                                                                                                                             |

### Lens B — Denials & faster cash

| Capability                                   | Status                    | Evidence                                                                                                                                                                         | Owner impact                                                                         |
| -------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Batch claim creation from fulfillments**   | **✅ Shipped in this PR** | was: `routes/admin/fulfillment-to-claim.ts` created one claim per click                                                                                                          | Clean claims stopped aging in the "to bill" queue; one-click batch.                  |
| **Backorder auto-clear on restock**          | **✅ Shipped in this PR** | was: `routes/admin/shop-backorders.ts` manual-clear only                                                                                                                         | Stops the order-flow substituting a SKU that's actually back in stock.               |
| **Secondary / COB auto-submit**              | **PARTIAL**               | auto-**draft** exists (`lib/billing/secondary-claim-generator.ts`); no worker auto-**submits** on primary 835 post                                                               | Adjudicated-ready secondary balances depend on a CSR noticing the worklist.          |
| **Prior-auth automation**                    | **PARTIAL**               | Da Vinci PAS submit works (`routes/admin/davinci-pas-submit.ts`) but is **not auto-triggered before claims**; no bulk PA engine; token env-only                                  | PA-required items wait on a manual click; front-loading PAs prevents the denial.     |
| **Appeals lifecycle tracking**               | **PARTIAL**               | appeal **letters** tracked (`migrations/0137`, `routes/admin/claim-appeals.ts`); mail/manual appeals have no "mark mailed" transition; no `responded_at`/`outcome`/aging columns | Can't measure appeal win-rate or age the appeal clock.                               |
| **Collections-forecast / AR aging accuracy** | **OPEN**                  | no `partially_paid` status; denied/appealed aged as collectible (`lib/billing/collections-forecast.ts`, `routes/admin/billing-reports.ts`)                                       | Owner cash forecast is overstated — a correctness gap that affects a money decision. |
| **Chargeback / dispute persistence**         | **OPEN**                  | Stripe `charge.dispute.*` only WARN-logs (`lib/stripe/webhook-handler.ts`); no disputes table/flag                                                                               | A missed dispute alert = a silently lost deadline = lost revenue.                    |

### Lens C — Fulfillment & inventory operations

| Capability                                 | Status               | Evidence                                                                                                                                                                                  | Owner impact                                                                                                                   |
| ------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Carrier tracking webhook ingest**        | **OPEN**             | `shipped_at`/`delivered_at` are admin-stamped; no EasyPost/Shippo webhook handler                                                                                                         | No auto-advance of fulfillment state, no auto-POD/auto-follow-up; manual status entry.                                         |
| **Inventory reservation / oversell guard** | **OPEN**             | stock is `shop_products.metadata.stock_count` (Stripe, point-in-time); no `inventory_reservations` table                                                                                  | Oversell risk under concurrency on cash-pay checkout.                                                                          |
| **Supplier purchasing / procurement**      | **OPEN — strategic** | inventory catalog + COGS + monthly reconciliation exist (`routes/admin/inventory-reconciliation.ts`); no purchase-orders-to-distributor, reorder points, multi-location stock, lot/serial | Buy-side loop is absent (note: warehouse pick/pack is intentionally provider/3PL-owned). Brightree/WellSky include purchasing. |

### Lens D — Growth & referral sources (the strategic builds)

| Capability                                                                  | Status                  | Evidence                                                                                                                                                                                                                                                                                         | Owner impact                                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-location / multi-tenant completion**                                | **PARTIAL — strategic** | org threading mid-migration (06-20 §2, mostly fixed for the authenticated surface; a few seed-org leaks remain); `dme_organization` singleton surfaces                                                                                                                                           | Hard ceiling on a second branch / acquired DME / SaaS resale. **See the Multi-location & multi-tenant build sketch below.**                                               |
| **Referral-source / physician CRM + adherence reporting back to referrers** | **OPEN — strategic**    | physician/NP registry + referral intake (Parachute / e-prescribe / fax / AI referral reviewer) exist; **no B2B referral-relationship management** (rep visit logs, referral volume by source/scorecards) and **no automated adherence/outcome report back to the referring physician/sleep lab** | DMEs grow on referral relationships; reporting adherence back is the stickiest retention lever for a referral source. **See the Referral-source CRM build sketch below.** |
| **Provider-facing RTM dashboard**                                           | **OPEN — strategic**    | provider portal is login + e-sign only (`routes/provider/portal.ts`); therapy device data is ingested but not surfaced to referring providers                                                                                                                                                    | Referral stickiness + a clinical-value differentiator vs. a fulfillment bureau. **See the Provider-facing RTM build sketch below.**                                       |

### Lens E — Clinical / adherence (supporting)

- **Real-time compliance alerts** — detection is nightly-batch
  (`worker/jobs/therapy-integrations-nightly-sync.ts`); no same-night "dropped
  below 4 hr" flag to the RT board. _Favorable, not blocking._
- **Sleep-study diagnostic parsing** — studies can be uploaded but AHI/severity
  isn't auto-extracted. _Minor._
- **Live therapy-cloud data** is **contract-blocked, not code-blocked** — the
  ResMed/Philips/3B adapters are production-ready; live pulls await executed
  partner BAAs/OAuth. _Business-development action, not engineering._

---

## Activation state — verified seeded flag/cron states (this session)

The "activation, not engineering" headline rests on the **seeded** flag state in
the migration ledger. `feature_flags` became **per-tenant** at migration 0350
(PK re-keyed to `(org_id, key)`), and any flag can be toggled at runtime from
`/admin/control-center` — so production may differ from the seed; confirm there.
Verified against the migrations this session:

| Lever                                               | Flag key                              | Seeded                         | Extra gate                                                             | Net today                                  |
| --------------------------------------------------- | ------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------ |
| Auto-reminder enrollment (cash-pay buyers)          | `storefront.auto_reminder_enrollment` | **ON** (0325, was OFF in 0174) | —                                                                      | **Active**                                 |
| Inbound email auto-reply                            | `email.auto_reply`                    | **ON** (0325, was OFF in 0250) | —                                                                      | **Active**                                 |
| Claim auto-submit                                   | `billing.auto_submit_claims`          | **ON** (0325, was OFF in 0215) | recurring schedule `CLAIMS_AUTOSUBMIT_CRON` (env, opt-in)              | Flag on; recurring schedule env-gated      |
| Cart-abandonment recovery                           | `cart_abandonment.dispatcher`         | **ON** (0149)                  | recurring cron `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED` (env, **OFF**) | Dispatcher on; recurring cron off          |
| Entitlement enforcement (too-soon / over-cap block) | `resupply.entitlement_enforcement`    | **OFF** (0172)                 | fail-open                                                              | **Dormant** — denial prevention            |
| Eligibility enforcement (dead-coverage block)       | `resupply.eligibility_enforcement`    | **OFF** (0185)                 | fail-open                                                              | **Dormant** — denial prevention            |
| Continued-use (adherence) check                     | `resupply.usage_compliance_check`     | **OFF** (0300)                 | fail-open                                                              | **Dormant** — audit-risk denial prevention |
| Patient autopay                                     | `billing.patient_autopay`             | **OFF** (0260)                 | + per-patient Stripe auth + `BILLING_PATIENT_AUTOPAY_CRON`             | **Dormant** — collections                  |
| Payment-plan autocharge                             | `billing.payment_plan_autocharge`     | **OFF** (0255)                 | + `BILLING_PAYMENT_PLAN_AUTOCHARGE_CRON`                               | **Dormant** — collections                  |
| Voice escalation tier (AI check-in call)            | `reminder_escalation.voice`           | **OFF** (0395)                 | voice path configured; 9am–8pm local window                            | **Dormant** — connection rate              |
| Review-request emails                               | _(no flag)_                           | n/a                            | **no pg-boss cron** — dispatcher + admin button only (06-20 §5)        | Needs a cron to automate                   |

**Read:** the revenue / CSR-cost levers (auto-reminder, cart-abandonment
dispatcher, email auto-reply, claim auto-submit) are **already ON**. The
remaining activation decisions are the three **enforcement** flags (denial
prevention — the biggest unflipped lever; each is fail-open, so the downside of
enabling is only an added CSR review step, never a stranded order),
**autopay / payment-plan autocharge** (collections), and the **voice escalation
tier** — plus wiring the cart-abandonment and review-request recurring
schedules. None of these is an engineering project.

---

## Sizing & sequencing (engineering work only)

Excludes the activation decisions above (hours, no engineering). Effort is rough
dev-days for one engineer; impact is the owner metric moved.

| Item                                               | Lens | Effort    | Impact                                                | Risk                                                                           |
| -------------------------------------------------- | ---- | --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| Resupply-due → draft order action                  | A    | M (3–5d)  | Recurring-revenue capture (#1 lever)                  | Med — creates orders; mitigate with draft-only + entitlement gate + CSR review |
| Carrier tracking webhook ingest                    | C    | M (3–5d)  | Auto fulfillment-state + auto-POD/follow-up; CSR time | Low — additive, fail-soft                                                      |
| Collections-forecast `partially_paid` accuracy     | B    | S (1–2d)  | Correct owner cash view                               | Low — read-path only                                                           |
| Secondary/COB auto-draft on 835 post               | B    | S (1–2d)  | Captures adjudicated-ready secondary balances         | Low — draft only; submit stays manual                                          |
| Chargeback / dispute persistence                   | B    | S (1–2d)  | Stops missed dispute deadlines                        | Low — additive table + alert                                                   |
| Appeals response / outcome / aging columns         | B    | S (1–2d)  | Appeal win-rate + aging visibility                    | Low — additive columns                                                         |
| Inventory reservation / oversell guard             | C    | M (3–5d)  | Prevents cash-pay oversell                            | Med — touches checkout                                                         |
| Membership tier ↔ Stripe webhook + join flow       | A    | M (3–5d)  | Recurring cash-pay + retention                        | Med — billing surface                                                          |
| Multi-location / multi-tenant completion           | D    | L (weeks) | Growth ceiling (2nd branch / resale)                  | High — cross-cutting                                                           |
| Referral-source CRM + adherence-to-referrer report | D    | L (weeks) | Referral growth + stickiness                          | Med — new domain                                                               |
| Provider RTM dashboard                             | D    | L (weeks) | Referral stickiness + clinical value                  | Med — new surface                                                              |

Suggested order: the four **S** RCM-accuracy items first (fast, low-risk, protect
cash) → **resupply-due → draft order** (the revenue lever) → **carrier webhooks**
→ then the strategic **L** builds once multi-tenant lands.

---

## Implementation sketches (top two follow-ups)

### Resupply-due → draft order (Lens A, #1 lever)

- **Reuse — the read side already exists:** `routes/admin/therapy-resupply.ts`
  `buildOpportunities()` + the `therapy_resupply_*` RPCs (migration 0180) return
  due items with `nextEligibleDate`; the entitlement engine
  (`lib/resupply-domain/entitlement.ts`, `refill-window.ts`) and the SKU→HCPCS
  map (`product_hcpcs_map`) already exist.
- **Build:** `POST /admin/therapy-resupply/draft-orders` taking
  `{ patientId, sku }[]` (or "all due ≤ N days") that, per item, runs the
  **entitlement + refill-window** check and creates a **draft** episode /
  fulfillment in the CSR review state — never an unattended shipment — mirroring
  the per-item-isolation + roll-up summary shape shipped in this PR's batch-claim
  route. Hold a too-soon/over-cap item behind `resupply.entitlement_enforcement`
  (or a new `resupply.draft_orders` flag) rather than shipping it.
- **Surface:** a "Create draft orders" bulk action on the Resupply
  Opportunities page returning `{ created, heldTooSoon, skipped }`.
- **Why this is low-risk:** draft-only + entitlement-gated + queued = no
  unattended shipment; the CSR confirms through the existing fulfillment path.

### Carrier tracking webhook ingest (Lens C)

- **Reuse:** fulfillments already carry `shipped_at`/`delivered_at` and a carrier
  label action (`routes/admin/xps-shipping.ts`); POD auto-send on delivery
  (`lib/patient-packet/auto-send-on-delivery.ts`) and the delivery-follow-up jobs
  already key off `delivered_at`.
- **Build:** a signature-verified, fail-closed webhook
  (`POST /resupply-api/webhooks/carrier`) that maps a tracking event → the
  fulfillment (by tracking number) and stamps `shipped_at`/`delivered_at`,
  advancing state and letting the existing POD/follow-up jobs fire on their own.
  Start with one vendor (EasyPost or Shippo) behind a `read…ConfigOrNull()`
  helper so it degrades when unconfigured — same fail-soft posture as the
  integration adapters.
- **Audit:** counts / status only — never tracking PII in logs (hard rule).

---

## Strategic build sketch — Referral-source CRM + adherence-to-referrer (Lens D)

**Why it matters to a DME owner.** A DME's growth _is_ its referral network —
sleep labs, pulmonology / ENT / PCP offices, hospital sleep programs. The
platform today can identify the prescriber on a claim but cannot **manage the
source relationship**: which accounts send patients, who owns each
relationship, what each is worth, and whether an office is growing or slipping.
This is the single biggest unbuilt **growth** lever, and the one capability a
fulfillment bureau (e.g. VGM Total Sleep Services) structurally can't hand back.

**What already exists (reuse, don't rebuild):**

- **Clinical prescriber registry** — `resupply.providers` (migration 0071):
  NPI-unique, NPPES-backed lookup (`routes/admin/providers.ts` +
  `providers.nppes-lookup`), with `practice_name` / `practice_address`. It is a
  **prescriber** record, not a **referral-source account** — no source type,
  status/pipeline, rep owner, territory, activity log, or volume/revenue rollup.
- **Referral intake** — inbound referrals (Parachute webhook, SMART-on-FHIR
  e-prescribe, inbound fax) get one AI extraction pass and land in the referral-
  review queue (`routes/admin/referral-reviews.ts`); accepting creates the
  patient and resolves a `referring_provider_id` onto the prescription/claim
  (`lib/billing/claim-builder.ts`).
- **Attribution + revenue plumbing** — the patient-level acquisition funnel
  (`routes/admin/acquisition-funnel.ts`) + payer-profitability + LTV/CAC RPCs
  already aggregate new-patients and net revenue over a window; a **source
  scorecard is the same query shape keyed on a source id**.
- **Adherence data + a renderable summary** — `patient_therapy_nights` +
  `cms-adherence` + the compliance-attestation PDF
  (`routes/admin/compliance-attestation.ts`) already produce a 30/90-day
  adherence document, and the tenant fax/email senders already exist.

**The gap (verified: no `referral_sources` table exists anywhere).** Build the
referral SOURCE as a first-class managed entity, plus rep activity, source
scorecards, a prospecting pipeline, and the adherence-report-back loop.
Phaseable:

- **Phase 1 — Source entity + linkage + scorecard (the 80/20).**
  - New `resupply.referral_sources` (org-scoped): `name`, `type`
    (`physician_office | sleep_lab | hospital | dme_partner | other`),
    `group_npi`, `address jsonb`, `status` (`prospect | active | inactive`),
    `owner_user_id` (the rep), `territory`, `notes`. Link a prescriber to its
    source via a nullable `providers.referral_source_id` FK, and stamp
    `referral_source_id` on the prescription/referral at intake (resolved from
    the referring provider, or chosen by the CSR in the referral-review accept
    step).
  - A **source scorecard** RPC mirroring the acquisition-funnel /
    payer-profitability RPCs: referrals, new patients, active patients, resupply
    conversion, and net revenue per source over a window, with a
    period-over-period trend so a slipping office surfaces.
  - Routes `/admin/referral-sources` (CRUD) + `/admin/referral-sources/:id/scorecard`,
    behind a new `referrals.read` / `referrals.manage` permission (so
    `check-admin-route-gates.sh` stays green).
- **Phase 2 — Rep activity + pipeline.** `referral_source_activities`
  (visit / call / email / lunch-and-learn log: actor, type, `occurred_at`,
  notes) + a simple pipeline (`prospect → contacted → active → at_risk`) and a
  rep worklist ("sources you own that are slipping or overdue for a touch").
  Reuses the alert/worklist patterns already in the admin console.
- **Phase 3 — Adherence-to-referrer (the stickiness lever).** A flag- +
  consent-gated job that, at the 30/90-day mark, renders the existing adherence
  summary for a referred patient and faxes/emails it to the **referring**
  provider via the tenant sender (a permitted treatment / care-coordination
  disclosure). This is what referral sources actually want back, and it's the
  retention differentiator a fulfillment bureau cannot offer.

**Conventions to respect:** Supabase-only data path + org-scoped client; Zod at
the HTTP boundary; `requirePermission` on every mutation; PHI rules (the
scorecard is counts / revenue — no patient identifiers; the adherence report is
a permitted disclosure to the treating provider and is never logged).

**Effort:** L overall, but **Phase 1 is M (3–5d)** — the scorecard reuses the
existing funnel/profitability RPC shape and the provider registry already
exists. Phase 1 alone answers the owner's core question, _"who sends me
patients and what are they worth?"_

---

## Strategic build sketch — Provider-facing RTM dashboard (Lens D)

**Why it matters.** The provider portal already exists but is **e-sign only**
(`routes/provider/portal.ts` is `requireProvider` + MFA-gated and serves a
signature-request queue scoped by `provider_id`). A referring physician /
sleep-lab can sign orders but **cannot see how their referred patients are
doing on therapy** — the exact "myAir for the referrer" view that keeps a
referral source loyal. It is the natural companion to the Referral-source CRM
above (and shares its Phase 3 push).

**What already exists (reuse, don't rebuild):**

- **Authenticated, MFA-gated provider portal** with strict per-provider
  scoping — every PHI route already filters `.eq("provider_id", account.providerId)`
  and adds `requireProviderMfaEnrolled` (`routes/provider/portal.ts`,
  `middlewares/requireProvider.ts`). The isolation primitive is in place.
- **Per-patient therapy reads + adherence math** — `routes/admin/patient-therapy-snapshot.ts`
  (usage / AHI / leak rollup), `cms-adherence` (30-day compliant-nights / CMS
  flag), and the renderable compliance-attestation PDF
  (`routes/admin/compliance-attestation.ts`).
- **Provider → patient linkage** — the ordering/referring provider is already on
  the chart (`prescriptions.provider_id` / claims' `referring_provider_id`,
  resolved in `lib/billing/claim-builder.ts`), so "this provider's patients" is
  a join, not new data.

**The gap / build (phaseable):**

- **Phase 1 — "My patients" roster + adherence summary.** A provider-scoped read
  (patients whose `prescriptions.provider_id` = `account.providerId`), reusing
  the admin therapy-snapshot logic but **provider-scoped + MFA-gated**: patient
  (name snapshot), setup date, last-night usage, 30-day compliant nights / CMS
  adherence flag, and trend. Mirrors the e-sign queue's existing `.eq("provider_id", …)`
  isolation so a provider sees **only** their own patients.
- **Phase 2 — Per-patient therapy detail + attestation download.** A read-only
  usage/AHI/leak trend (reuse `patient-therapy-snapshot.ts`) and a one-click
  "download adherence attestation PDF" (reuse `compliance-attestation.ts`) — the
  documentation a referrer needs for the Medicare 90-day window.
- **Phase 3 — Proactive push** (shared with the Referral-CRM sketch): the
  flag-/consent-gated 30/90-day adherence summary faxed/emailed to the referrer.

**Conventions / caveats:** every read MUST filter by `account.providerId` (the
isolation the portal already enforces); MFA-gate every PHI route
(`requireProviderMfaEnrolled`); PHI-safe logging. **Note the 06-20 finding** that
the provider portal currently resolves the **seed org** rather than threading
`req.orgId` — fix/thread `orgId` as part of this build so a non-seed tenant's
provider sees the right patients.

**Effort:** M — the auth/MFA/portal shell and the therapy-snapshot read both
exist; the new work is the provider-scoped roster join + a read-only UI.

---

## Strategic build sketch — Multi-location & multi-tenant completion (Lens D)

Two distinct tracks share this heading; they are at very different stages.

### Track 1 — Multi-tenant (platform / `organizations`): ~complete, finish the tail

**State (verified).** The tenant cutover has largely happened — `organizations`
(migration 0331) + the `org_id` threading (0341 / 0342), with **341 route files
on `getOrgScopedClient`** and the 06-20 review confirming the authenticated
admin surface fails closed without `req.orgId`. Per-tenant Stripe Connect (0375)
and platform billing packages (0362) exist, and `scripts/src/tenant-onboard.ts`
provisions a new tenant. The CLAUDE.md "no application route imports the
org-scoped client yet" note is **stale**.

**Remaining (small).** The narrow seed-org callsites in 06-20 §2 — mostly fixed
in that PR; the open tail is the **davinci-pas Bearer-token namespace** (per-payer
PAS creds shared across tenants via process env) and the **object-storage
helpers** (resolve seed org rather than a caller org — no reachable cross-tenant
read today, but track for true storage isolation), plus the **provider portal**
org threading (shared with the RTM sketch). This is finish-the-tail, **not** a
new build. **Effort: S–M.**

### Track 2 — Multi-location (branches within one tenant): groundwork only — the real build

**State (verified).** `resupply.locations` (migration 0235) exists — business
**branches** (name / code / address / phone / `npi` / `is_primary`), with
**nullable** `patients.location_id` / `admin_users.location_id` anchors that
deliberately re-scope nothing. The `multi_location.enabled` flag (0257) is seeded
**OFF**, and when on only surfaces the Locations page + branch pickers + a
patients-list filter + per-branch counts. **Billing identity is shared at the org
level in both modes — the flag never touches claims** (per the migration's own
note). So today this is a UI / grouping shell, not an operational multi-branch
system.

**The build (phaseable):**

- **Phase 1 — Per-location billing identity (the hard requirement).** A real
  multi-branch DME bills each branch under its **own NPI / PTAN**.
  `locations.npi` already exists as the anchor; extend the billing identity
  resolver (`lib/billing/identity-resolver.ts`) to prefer a **location-level**
  identity when the servicing patient carries a `location_id`, falling back to
  the org-level identity. Without this, every branch's 837P goes out under one
  NPI — so this is the piece that makes multi-branch real for claims.
- **Phase 2 — RBAC / worklist scoping by branch.** `admin_users.location_id`
  already exists; add an **optional** location filter to the worklists and a soft
  "default to my branch," behind the existing flag (the UI scaffolding is the
  part already shipped).
- **Phase 3 — Per-branch analytics.** Add a `location_id` group-by dimension to
  the existing analytics RPCs (acquisition funnel, margin, AR aging) — same RPC
  shape reused (and the same pattern as the referral-source scorecard above).

**Out of scope by design:** locations are **not** warehouses — per-branch
**stock** is explicitly excluded (architecture Rule 14; PacWare is the inventory
system of record). Don't build per-location inventory here.

**Effort:** L overall (Phase 1 touches the claim path). But Track 1 is the
near-term "completion" item, and Track 2's **Phase 1 is the only piece a
multi-branch owner truly needs first**.

---

## Prioritized recommendation

1. **Run a dormant-lever activation pass** (Lens A — see **Activation state**).
   The revenue/CSR-cost levers are already ON; the remaining decisions are the
   three **enforcement** flags (denial prevention, fail-open — biggest unflipped
   lever) and **autopay / payment-plan autocharge** (collections), plus the
   **voice escalation tier** and wiring the cart-abandonment / review-request
   recurring schedules. Owner makes the consent/staffing call, then toggles in
   `/admin/control-center`. **Highest ROI, ~0 engineering.**
2. **Shipped in this PR** (Lens B/C): batch claim creation + backorder
   auto-clear (below).
3. **Resupply-due → draft/batch order** (Lens A #1) — add a "create draft
   order(s)" action to `therapy-resupply.ts`, entitlement-gated, queued for CSR
   review. Converts the existing worklist into recurring revenue.
4. **Fulfillment last-mile** (Lens C) — carrier tracking webhook ingest (auto
   POD/follow-up) + an `inventory_reservations` oversell guard.
5. **RCM accuracy/automation** (Lens B) — collections-forecast `partially_paid`
   accuracy, secondary/COB auto-draft on 835 post, dispute persistence.
6. **Strategic** (Lens D) — finish multi-tenant; then referral-source CRM +
   adherence-report-to-referrer; then provider RTM. These are the growth
   ceiling, not quick wins.

---

## Shipped in this PR (the two top quick-wins)

Both are additive, fail-soft, fully tested, and require **no migration**.

- **Batch claim creation from fulfillments** —
  `POST /admin/billing/fulfillments/batch-create-claims`
  (`routes/admin/billing-batch-create-claims.ts`). Reuses the SAME core as the
  single-click route via the extracted `lib/billing/create-claim-from-fulfillment.ts`
  helper (so the two paths can't diverge), with per-item isolation + duplicate
  guard + bill-hold seeding. SPA: a "Create all claims" action on the Billing
  Hub "Fulfillments ready to bill" card. **Lever:** throughput / faster cash —
  clean claims stop aging in the queue.
- **Backorder auto-clear on restock** —
  `lib/backorder/auto-clear-on-restock.ts`, hooked into the admin
  shop-inventory save (`routes/admin/shop-products.ts`) at the same 0→positive
  stock transition that fires the back-in-stock notify queue. Clears any open
  `shop_backorders` row for the product's `metadata.shop_sku`, idempotent +
  audited + fail-soft. **Lever:** fulfillment ops + reorder capture — the
  resupply order-flow stops substituting a SKU that's back in stock.

---

## Appendix — "already shipped, do NOT rebuild"

So the owner doesn't fund rebuilds. Each was, at some point, called a gap; each
is in fact shipped (often automated). Verified this session.

- **Paperwork:** ABN (`migrations/0417`), AOB / financial-responsibility form
  acks (`0106`, `routes/admin/form-acknowledgements.ts`), Proof-of-Delivery
  (`0111`, `routes/shop/order-pod.ts`), signed-paperwork claim gate
  (`0248`/`0253`, `lib/paperwork/require-signed-paperwork.ts`), CMN/DIF
  (`migrations/0202`, `lib/billing/cmn-forms.ts`), DWO, patient packets +
  e-sign.
- **RCM/EDI:** 270/271, 276/277, 837P batch, 835/ERA auto-post, 999, Da Vinci
  PAS, secondary/COB draft, denial analyzer + appeal letters + outbound fax,
  timely-filing, capped-rental KX/RB→RJ, same-or-similar, payer
  profiles/fee-schedules/modifier rules, Good-Faith Estimates.
- **Payments:** Stripe checkout, per-tenant Connect, patient autopay, payment
  plans, statements.
- **Resupply/comms:** Medicare-cadence reminders, signed-link YES/EDIT/STOP,
  inbound-SMS + IVR reorder, bulk campaigns, omnichannel inbox, 3-vendor AI
  (voice/SMS/email/chatbot), sleep coach, on-device mask fitter, RMA/returns,
  asset recovery, lapsed-customer win-back.
- **Analytics:** acquisition funnel, LTV/CAC, margin/COGS, payer profitability,
  AR aging / DSO, inventory turnover, CSR productivity, NPS.

---

_Verified against `claude/upbeat-keller-dcxw5o`. When an OPEN/PARTIAL item ships,
update this file rather than the older reviews._
