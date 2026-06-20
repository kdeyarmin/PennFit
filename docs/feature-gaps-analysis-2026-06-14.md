# Feature-Gap Analysis — Productivity, Profit, Reordering & Reimbursement (2026-06-14)

**Author:** automated code-verified review
**Scope:** Where can PennFit increase staff productivity, profit, reorder
capture, and reimbursement? What is genuinely missing vs. already shipped?
**Method:** Full inventory of the admin console (~145 pages, ~200 API
routes), the patient storefront/portal, the billing/RCM stack, and the
~60 pg-boss worker jobs — then **direct code verification** of every
candidate gap before listing it. Benchmarked against current DME-resupply
industry practice (WellSky/S3, Brightree, NikoHealth) for 2025–2026.

---

## TL;DR — the headline is counter-intuitive

PennFit is **not** short on features. By any DME-resupply benchmark it is
one of the most complete platforms in the category — it already ships the
things competitors sell as premium add-ons: real-time 270/271 eligibility,
276/277 claim-status inquiry, 837P batch submit, 835/ERA auto-posting, AI
claim scrubbing + denial analysis, capped-rental modifier rotation, PECOS
validation, Da Vinci PAS prior-auth, secondary/COB claim generation,
outbound fax for PA/appeals, auto-statements, patient autopay + payment
plans, lapsed-customer win-back, same-or-similar checking, and a full
voice/SMS/email reorder stack.

**The single biggest finding of this review:** several of the highest-value
**revenue-protection and reorder-growth capabilities are already built but
shipped disabled** (feature flag seeded `false`). The fastest path to more
profit and fewer denials is **an activation decision, not an engineering
project.**

A secondary finding: the prior gap docs in `/docs` (and any quick
"what's missing" scan) **substantially over-state the gaps** — ~80% of the
items they call missing are in fact shipped and, in many cases, automated.
This document corrects that record with file-level evidence so the owner
isn't paying to rebuild what already exists.

---

## Part 1 — The real lever: built-but-dormant features (activate, don't build)

These capabilities exist in code and are gated behind feature flags that are
**seeded `false`**. (Production may have toggled some ON since via
`/admin/control-center` → verify there; the seed default is the starting
point.) Each one directly moves profit, reorder rate, or denial rate.

| Flag (seed default)                                                        | What turning it ON does                                                                                                                                                                                                                              | Business impact                                                                                                                                                                                                                  | Evidence                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `storefront.auto_reminder_enrollment` — **OFF**                            | Auto-enrolls every cash-pay storefront buyer into replacement reminders for the consumables they bought (mask/cushion/tubing/filter) at standard cadence; email-only, manage/unsubscribe token, never re-enrolls a prior unsubscribe.                | **Largest recurring-reorder lever.** Today only customers who find `/reminders` and opt in get nudged; every other buyer is a one-and-done sale. Industry reorder programs run 45–50% order rates — this is the on-ramp to that. | `storefront/order-reminder-enrollment.ts:141`; seed `0174_storefront_auto_reminder_flag.sql`   |
| `resupply.entitlement_enforcement` — **OFF**                               | Blocks a reorder confirmation that isn't yet payable under the Medicare/payer replacement schedule (too-soon since last dispense, or over the per-period quantity cap) and routes it to a CSR alert instead of shipping. Fails open on lookup error. | **Stops denial leakage at the source.** Shipping a too-soon/over-cap item guarantees a denial and an unbillable unit (COGS + labor lost). This is the cheapest denial-prevention in the system.                                  | `lib/entitlement/resolve-sku-entitlement.ts`; seed `0172_resupply_entitlement_enforcement.sql` |
| `resupply.eligibility_enforcement` — **OFF**                               | At order-confirm, consults the cached 270/271: an explicitly inactive plan or a prior-auth-required flag raises a `resupply_coverage_blocked` alert and routes to the work queue instead of auto-shipping. Fail-open on no/stale result.             | **Stops shipping to dead coverage.** Front-end eligibility blocking is the #1 denial-reduction tactic in the 2026 DME RCM guidance; the data is already on file, it just isn't gating.                                           | seed `0185_eligibility_enforcement_flag.sql`                                                   |
| `resupply.usage_compliance_check` — **verify**                             | Gates resupply on therapy-usage compliance (Medicare ≥4 hr/night adherence) before a claim ships.                                                                                                                                                    | Prevents the most audit-exposed denial class (resupply with no documented usage).                                                                                                                                                | `feature-flags.ts:` key present; worker gating                                                 |
| `billing.auto_submit_claims` — **verify**                                  | Preflight-clean drafts auto-batch and submit on the `auto-submit-batch` cron instead of waiting for a CSR to click "submit."                                                                                                                         | **Throughput + cash-flow.** Removes the manual gate where clean claims age in `draft`, slipping toward timely-filing limits.                                                                                                     | `worker/jobs/auto-submit-batch.ts`                                                             |
| `billing.patient_autopay` / `billing.payment_plan_autocharge` — **verify** | Auto-charges saved cards for patient responsibility / runs payment-plan installments.                                                                                                                                                                | **Collections + bad-debt.** Installment/auto-charge lifts patient collections ~25% per 2026 RCM data.                                                                                                                            | `worker/jobs/patient-autopay-charge.ts`, `payment-plan-autocharge.ts`                          |
| `cart_abandonment.dispatcher` — **verify**                                 | Recovers abandoned storefront carts via automated follow-up.                                                                                                                                                                                         | Direct cash-pay revenue recovery; zero marginal labor.                                                                                                                                                                           | `worker/jobs/cart-abandonment-scan.ts`                                                         |
| `email.auto_reply` — **OFF (by design)**                                   | High-confidence inbound patient emails answered automatically by the chatbot brain; low-confidence falls through to a human.                                                                                                                         | **CSR productivity.** Deflects routine email volume. Deliberately OFF pending a consent decision (ADR 013) — a policy call, not a code gap.                                                                                      | `lib/messaging/email-auto-reply.ts`                                                            |

**Recommended action:** Run a one-time "dormant-lever activation" pass.
For each flag above, the owner makes an explicit business/consent decision
(CAN-SPAM review for auto-reminders; CSR-staffing review for enforcement
alerts), then toggles it in `/admin/control-center`. This is the
highest ROI work available and requires **no new engineering** for the
first four rows. Start with `storefront.auto_reminder_enrollment` (revenue)
and the two `resupply.*_enforcement` flags (denial prevention).

> **Why they're OFF:** these aren't half-built. They're intentionally
> fail-open and seeded off because each one either contacts patients
> (consent posture) or creates CSR work (staffing posture). The gating is a
> safety decision the owner is meant to make — this review's job is to
> surface that the decision is pending and the upside is large.

---

## Part 2 — Genuinely open build gaps (small list, verified)

After verifying every candidate against code, the list of things that are
_actually not built_ and would move the target metrics is short:

### 2.1 Secondary/COB claim generation is manual-only (no auto-trigger)

- **State:** `secondary-claims.ts` exists with a worklist that surfaces
  primary claims that posted with a patient-responsibility balance **and** a
  secondary coverage on file; a human clicks `POST /admin/claims/:id/generate-secondary`.
  There is **no worker** that auto-generates the secondary when the primary
  835 posts (`era-reconciler.ts` has no secondary hand-off).
- **Impact:** Dual-eligible / commercial-primary + Medicare-secondary
  balances depend on a CSR noticing the worklist. Missed secondaries =
  uncollected revenue that's already adjudicated-ready.
- **Recommendation:** Add an opt-in pass to `auto-workflow-engine.ts`
  (it already runs every 5 min and auto-analyzes denials + generates
  statements) that drafts the secondary claim when the primary posts with
  a balance + secondary coverage, leaving submit behind a human approval (or
  a flag), mirroring the existing auto-submit posture. **Small, high-yield.**

### 2.2 Multi-location / multi-tenant is a singleton

- **State:** `dme_organization` is a single-row table; `multi_location.enabled`
  flag and `locations.ts` exist but the billing identity resolver and most
  surfaces assume one org. Schema is forward-compatible (mig 0132) but the
  feature is unbuilt.
- **Impact:** Hard ceiling on growth (second branch / acquired DME / SaaS
  resale). **Not** a near-term profit lever for a single-site operator.
- **Recommendation:** Defer until there's a concrete second-location or
  resale trigger; track as a strategic item, not a quick win.

### 2.3 Live therapy-cloud data is contract-blocked, not code-blocked

- **State:** ResMed AirView, Philips Care Orchestrator, and 3B adapters are
  production-ready and wired into the nightly sync registry; live pulls are
  gated on executed partner BAAs/OAuth, not on missing code.
- **Impact:** Device-driven resupply timing and adherence interventions run
  on partial data until the BAAs close.
- **Recommendation:** This is a **business-development action** (close the
  ResMed/Philips agreements), not an engineering task. Flag it to whoever
  owns vendor contracts.

### 2.4 Smaller, opportunistic build items (nice-to-have, not blocking)

- **Patient-responsibility breakdown** in the ERA path lumps
  copay/coinsurance/deductible into one `patient_responsibility_cents`
  rather than itemizing from the CAS segments — itemizing would let
  statements say "$25 copay" vs. a generic balance and improve patient-pay
  conversion. (`era-reconciler.ts`)
- **Performance-at-scale hygiene:** ~68 `count: 'exact'` calls on unbounded
  hot tables (e.g. `inbox-counts.ts`, `billing-director.ts`) and several
  in-memory aggregations capped at `.limit(20000)`; switch badge counts to
  `'estimated'` and push large aggregations into SQL RPCs before
  patient/claim volume grows. Productivity (page latency), not feature.

---

## Part 3 — What prior analyses called "gaps" but is actually shipped

So the owner doesn't fund rebuilds: each of these was flagged as missing in
an earlier review or a naive scan, and each is in fact **shipped** (often
automated). Verified this session.

| Claimed gap                                 | Reality                                                                                                                                                                      | Evidence                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "Denial analysis is manual"                 | **Auto-analyzed.** `auto-workflow-engine.ts` runs every 5 min: scores/scrubs risky drafts, analyzes fresh denials, generates statements. ERA poller also analyzes on ingest. | `lib/billing/auto-workflow-engine.ts:173`                                                               |
| "No periodic eligibility re-verification"   | **Shipped cron.**                                                                                                                                                            | `worker/jobs/eligibility-reverify-batch.ts`; flag `eligibility.auto_reverify`                           |
| "No auto-batch claim submission"            | **Shipped cron** (flag-gated).                                                                                                                                               | `worker/jobs/auto-submit-batch.ts`                                                                      |
| "No 276/277 claim-status inquiry"           | **Shipped.** EDI 276 builder + 277 parser + route.                                                                                                                           | `edi/276.ts`, `edi/parse-277.ts`, `routes/admin/claim-status.ts`, `lib/billing/claim-status-checker.ts` |
| "Outbound fax for PA/appeals is a stub"     | **Shipped.** Fax render + token + send path for PA requests and appeal letters.                                                                                              | `lib/billing/pa-request-render.ts`, `manual-documents/render-for-fax.ts`, `lib/fax/*`                   |
| "Same-or-similar (HETS OSE) ready to build" | **Shipped route.**                                                                                                                                                           | `routes/admin/same-or-similar.ts`                                                                       |
| "No patient financing / payment plans"      | **Shipped.** Autopay + payment-plan auto-charge crons.                                                                                                                       | `worker/jobs/patient-autopay-charge.ts`, `payment-plan-autocharge.ts`                                   |
| "No win-back for lapsed patients"           | **Shipped cron.**                                                                                                                                                            | `worker/jobs/lapsed-customer-winback.ts`                                                                |
| "Capped-rental lifecycle not automated"     | **Shipped cron** (KX/RB→RJ rotation).                                                                                                                                        | `worker/jobs/capped-rental-advance.ts`                                                                  |
| "PECOS / prior-auth expiry not automated"   | **Shipped crons.**                                                                                                                                                           | `worker/jobs/pecos-sync.ts`, `prior-auth-expiry-sweep.ts`, `pa-mco-sla-sweep.ts`                        |
| "Rx renewal not automated"                  | **Shipped crons.**                                                                                                                                                           | `worker/jobs/rx-renewal-send.ts`, `prescription-request-auto-draft.ts`                                  |
| "No secondary-claims feature"               | **Shipped** (manual trigger — see 2.1 for the _automation_ gap).                                                                                                             | `routes/admin/secondary-claims.ts`                                                                      |

---

## Part 4 — Prioritized recommendation

| Priority | Action                                                                                                                                                                | Type    | Effort    | Lever                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------- | ----------------------------- |
| **P0**   | Activate `storefront.auto_reminder_enrollment` (after CAN-SPAM/consent sign-off)                                                                                      | Toggle  | Hours     | Reorder revenue               |
| **P0**   | Activate `resupply.entitlement_enforcement` + `resupply.eligibility_enforcement` (after CSR-staffing sign-off)                                                        | Toggle  | Hours     | Denial prevention             |
| **P1**   | Verify & activate `billing.auto_submit_claims`, `billing.patient_autopay`/`payment_plan_autocharge`, `cart_abandonment.dispatcher`, `resupply.usage_compliance_check` | Toggle  | Hours     | Cash flow, collections, audit |
| **P1**   | Auto-draft secondary/COB claim on primary 835 post (new pass in `auto-workflow-engine.ts`)                                                                            | Build   | Small     | Reimbursement                 |
| **P2**   | Itemize patient responsibility (copay/coinsurance/deductible) from ERA CAS segments                                                                                   | Build   | Small     | Patient collections           |
| **P2**   | Performance hygiene: `count:'estimated'` for badges; SQL RPCs for capped aggregations                                                                                 | Build   | Small–Med | Staff productivity (latency)  |
| **P2**   | Close ResMed/Philips BAAs to unblock live therapy data                                                                                                                | Bus-dev | n/a       | Reorder timing, adherence     |
| **P3**   | Multi-location / multi-tenant                                                                                                                                         | Build   | Large     | Growth ceiling (deferred)     |

### Bottom line

The profit, reorder, and reimbursement upside here is **mostly unlocked by
deciding to turn on capabilities that are already built and fail-open**, not
by writing new features. The only genuinely worthwhile _new_ build is
auto-drafting secondary/COB claims. Everything else is activation, business
development, or scale hygiene.

> **Caveat on flag state:** this analysis reads the _seeded_ defaults from
> migrations. The live production state should be confirmed in
> `/admin/control-center`; some flags may already be ON. The activation
> recommendation is "review each pending decision and flip deliberately,"
> not "assume all are off."
