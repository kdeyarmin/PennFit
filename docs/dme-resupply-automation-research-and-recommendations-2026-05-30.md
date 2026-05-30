# DME Resupply Automation — Market Research & PennFit Recommendations

**Date:** 2026-05-30
**Audience:** Penn Home Medical Supply ownership + engineering.
**Purpose:** (1) Summarize what commercial DME/CPAP resupply-automation
software does and the value it delivers to the DME business, its
customer-service reps (CSRs), and its respiratory therapists (RTs);
(2) review PennFit against that market; (3) recommend a prioritized set
of additions/enhancements **calibrated to the product's actual chosen
direction** (lean, AI-native, PA-focused CPAP fitting + storefront +
resupply + billing — with HIPAA/DMEPOS/ACHC compliance handled out of
band per migration `0156_drop_compliance_machinery.sql`).

> This doc updates and partially supersedes
> [`competitive-gap-analysis-2026-05-19.md`](./competitive-gap-analysis-2026-05-19.md),
> which predates (a) the compliance-machinery teardown (0156) and (b) the
> billing-wave-2 / fitter-supply-campaign work shipped in migrations
> 0128–0156. Several "critical gaps" in that doc are now scaffolded.

---

## Part 1 — What DME resupply automation software does

CPAP/PAP supplies are a **recurring-revenue annuity**: every PAP patient
needs replacement cushions, masks, filters, tubing, headgear, and water
chambers on a fixed cadence, and payers (Medicare especially) will only
pay if the patient actually wants/uses them and the documentation is
clean. Patients rarely reorder proactively, so the entire category lives
or dies on **outreach + frictionless confirmation + clean billing**.

The dominant platforms are **Brightree ReSupply** (ResMed-owned; acquired
SnapWorx in 2025), **WellSky / S3 Resupply** (formerly Bonafide),
**NikoHealth**, plus billing-centric tools (TIMS, TeamDME, DMEworks,
Fastrack) and a newer AI-engagement wave (Neru Health, DME Flow). What
they all do, distilled:

### Core capabilities

| Capability                                      | What it does                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Eligibility / replacement-schedule tracking** | Knows, per item and per payer, when a patient is next eligible (e.g. Medicare LCD: disposable filters 2×/mo, cushions 1–2×/mo, mask & tubing every 3 mo, headgear/chamber/non-disposable filter every 6 mo). Compliance checks (eligibility, utilization, documentation, authorization) typically begin **~28 days before** an order is due so exceptions get worked early. |
| **Multi-channel outreach**                      | Reaches patients via the channel they'll answer: **SMS/text, email, IVR/automated voice, live call, mobile app, web portal**. Multi-channel beats single-channel decisively on connection rate.                                                                                                                                                                             |
| **Frictionless self-service confirmation**      | The signature feature: a **secure "magic link"** via text/email — no app download, no password, no portal login. Patient sees their due items (often **with product images**) and taps to confirm. NikoHealth reports this lifted confirmation response from **5% → 20%**.                                                                                                  |
| **Order generation → fulfillment**              | Confirmed orders flow straight into a fulfillment queue, deplete inventory, and auto-generate the invoice/claim — "the patient orders, it ships, it gets billed, without a human touch."                                                                                                                                                                                    |
| **Real-time eligibility & benefits (270/271)**  | Verifies active coverage, deductible/OOP, copay, PA-required flags before billing. Cuts eligibility denials **90–95%**; eligibility errors are ~22% of all DME denials.                                                                                                                                                                                                     |
| **Compliance / adherence monitoring**           | Pulls device usage (ResMed AirView, Philips Care Orchestrator, etc.) to confirm the **Medicare 4hr-night / 70%-of-nights-in-30-days** adherence rule, and flags non-adherent patients.                                                                                                                                                                                      |
| **Documentation & authorization**               | Stores Rx/CMN/DWO, prior auths, sleep studies; tracks refresh cycles so claims are audit-ready.                                                                                                                                                                                                                                                                             |
| **Work queues + exception handling**            | Staff get a **prioritized worklist** of only the orders that _need_ a human (failed contact, eligibility miss, doc gap) — the routine 80% is automated.                                                                                                                                                                                                                     |
| **Analytics / benchmarking**                    | Connection rate, conversion/order rate, items-per-order, average order value, orders-per-patient-per-year, retention, denial rate, DSO.                                                                                                                                                                                                                                     |

### How it helps the **DME company** (the business case)

- **More recurring revenue.** Automated, timely outreach drives order
  frequency and capture. Brightree publishes customer results of
  **+42% items per order** and **+46–50% revenue per order**. Managed
  live-outreach programs report **45–50% order rates** at **$175+ AOV**.
- **Scale without headcount.** Vendors advertise handling **2–4× the
  patient volume with the same staff** by automating the routine and
  leaving only exceptions to people.
- **Fewer denials / faster cash.** Embedded eligibility + documentation
  checks cut denials (which cost DMEs ~2–5% of revenue in write-offs and
  rework). NikoHealth case studies cite doubled net collections and
  ~20% faster collection.
- **Better therapy adherence → retention.** Patients with timely
  supplies stay on therapy; adherence programs have moved compliance
  from the ~50% national average toward ~85%, with **2×+** order volume.

### How it helps **CSRs** (customer-service reps)

- **Work a queue, not a phone book.** Instead of cold-calling every
  patient, CSRs get a triaged list of only the patients/orders that need
  attention. The routine reorders self-serve.
- **Full context in one screen.** Last order, eligibility, insurance,
  device, adherence — no swivel-chair between systems.
- **Guided scripts + canned replies + templates** make every contact
  faster and more consistent.
- **Less manual data entry.** Confirmed orders auto-create the sales
  order/claim; documentation prompts are built into the flow.
- Net: the job shifts from **repetitive dialing** to **exception
  resolution** — higher value, less burnout, far more throughput.

### How it helps **respiratory therapists** (RTs / clinical staff)

- **Adherence dashboard.** Device-cloud data surfaces who is
  non-adherent (low hours, high AHI, high leak) so RTs spend clinical
  time when it matters instead of reviewing compliant patients.
- **Targeted intervention.** Early-warning flags (e.g. week-1 usage
  <4 hr) let RTs coach mask-fit, pressure, and dry-mouth issues _before_
  the patient quits or fails the Medicare 90-day window.
- **Documentation is automatic**, so RTs aren't chasing paperwork to
  prove medical necessity.

---

## Part 2 — How PennFit measures up today

PennFit is **well past mid-tier**. It is a genuinely broad platform: a
privacy-first at-home **mask fitter** (on-device facial measurement,
images never transmitted), a **D2C storefront** (Stripe, wishlist,
reviews, NPS, Apple Wallet, EN/ES), a **resupply outreach engine**, a
**multi-channel admin console** (99 admin pages / 140+ API endpoints),
an **insurance-billing suite**, **four therapy-cloud integrations**, and
a **three-vendor AI stack** (OpenAI Realtime voice, Claude text, Deepgram/
ElevenLabs). Highlights mapped from the code:

### Where PennFit already leads or matches the market

- **At-home CV mask fitter + recommendation engine** — most resupply
  vendors don't have this; it's a top-of-funnel acquisition asset
  (vs. MaskFit AR / sovaFit).
- **Multi-touch fitter "supply campaign"** (migrations 0151–0156): a
  real journey state machine on `fitter_leads`
  (`consent → completed → campaign_active → reorder_active →
final_call_pending → converted/expired`), with per-touch
  open/click/engagement tracking, **hot-lead detection**, CSR
  contact/notes workflow, and a cold-skip optimizer. This is genuinely
  sophisticated lifecycle marketing.
- **Reminder engine** (`worker/jobs/reminders.ts`, `lib/resupply-reminders`):
  hourly eligibility scan, Medicare LCD L33718 cadences seeded
  (`0070_seed_medicare_cadences.sql`), per-patient overrides,
  TCPA business-hours gating, quiet-period suppression, idempotent
  dedup keys, SMS/email send + inbound `YES/EDIT/STOP` keyword handling.
- **Admin console depth**: conversations inbox (SMS/MMS/email/in-app)
  with SLA + skill-based routing; `My Today` unified worklist; episodes
  queue; RT Overview therapy board; clinical analytics (resupply funnel,
  compliance cohorts, CSR productivity); macros/templates/bulk campaigns;
  reports (CSV/PDF/QuickBooks).
- **Billing suite** (migrations 0118–0150): claims model + line items +
  event trail, Office Ally **837P** builder over SFTP, **ERA (835)**
  tables, **denial-code catalog** (~50 CARC/RARC), **payer profiles**
  (~25 PA payers seeded) + fee schedules + modifier rules, and an
  **AI claim scrubber + denial analyzer** (`0131_ai_claim_intelligence`)
  with a defensive patch-whitelist and `can_auto_resubmit` gate.
- **Inbound order channels**: Parachute (HMAC webhook) + SMART-on-FHIR
  EHR, with a typed referral inbox + preflight checks.
- **Prior-auth**: capture model + a Da Vinci PAS FHIR bundle builder.

### The deliberate simplification (important context)

Migration **`0156_drop_compliance_machinery.sql`** dropped the backing
tables for eleven in-app HIPAA/DMEPOS/ACHC compliance domains (the
audit-log HMAC **tamper-evidence chain**, BAA inventory, OIG LEIE
screening, HIPAA risk assessments, patient rights/disclosure logs,
contingency drills, ACHC QAPI, DME ownership disclosure, staff training,
…). It **deliberately RETAINED** the surfaces live code still
reads/writes — notably the **`audit_log` table** (the admin audit trail
is still active; only the HMAC tamper-evidence chain was removed),
**`patient_grievances`** (the grievance intake form + admin queue are
live), and `accreditation_documents`. The `@workspace/resupply-audit`
package is now a no-op stub. **Compliance is otherwise handled out of
band by the business owner.** Likewise, column-level PHI encryption
(0025) and the password pepper (#38) were removed. **Recommendations
below respect this — they do not propose rebuilding any of it.**

### Where PennFit is **scaffolded but the loop isn't closed**

The biggest opportunities aren't missing data models — they're missing
**wiring**. Cross-referenced across all three code surveys:

1. **Real-time eligibility (270/271)** — tables (`0134` `eligibility_checks`,
   `same_or_similar_checks`) and a `/admin/billing/eligibility` worklist
   exist, but the actual 270 builder / 271 parser / clearinghouse wire
   appears unwired (no Availity/Change/Office-Ally round-trip found).
2. **Claims loop** — 837P builds, but there's no scheduler that submits
   on claim-ready, and **no poller** for inbound 999 / 277CA / 835
   acknowledgments (the `clearinghouse_inbound_files` / `era_files` audit
   tables exist; the ingest worker does not).
3. **Da Vinci PAS** — bundle builder + submit function exist, but nothing
   triggers submission and there's no `ClaimResponse` webhook handler.
4. **Eligibility is not enforced at order time** — a patient can confirm
   a resupply via SMS even when coverage is missing/PA-required; the
   cached eligibility result isn't consulted before a fulfillment is
   created.
5. **Storefront orders ↔ resupply fulfillment are two disconnected
   flows** — a `public.orders` storefront order does not create a
   `resupply.episodes`/`fulfillments` row, so CSRs reconcile two systems.
6. **HCPCS codes live in `frequency_rules` _names_, not a mapping table** —
   so eligibility (HCPCS-keyed), catalog (Stripe IDs / `item_sku`
   strings), and quantity entitlement can't be joined.
7. **No rich self-service confirmation page** — outreach is SMS
   `YES/EDIT/STOP` text only; there's no magic-link landing page showing
   due items **with images** (the single highest-leverage feature in the
   competitor set).
8. **No patient-facing order portal** for resupply (view/track/cancel/
   reorder); `/account` exists but resupply self-service is thin.
9. **Therapy nightly-sync + adherence alerting** — four cloud adapters
   exist and `patient_therapy_nights` / `_milestones` are modeled, but a
   confirmed nightly sync job and real-time adherence-drop alerts to the
   RT board weren't found.
10. **Voice is outbound/manual only** — OpenAI Realtime bridge exists, but
    there's no **inbound "call to reorder" IVR**.

### Stale / vestigial surface to clean up

- Admin pages `/admin/compliance`, `/admin/accreditation-binder` and RBAC
  permissions `training.manage`, `grievances.read/.resolve`,
  `audit.read/.export` now point at tables dropped by 0156. Per CLAUDE.md
  the audit_log readers short-circuit to "no longer tracked" notices, but
  the **dead pages + permissions should be removed** so the console
  reflects reality (and so a demo doesn't surface empty compliance tabs).

---

## Part 3 — Recommendations (prioritized)

Calibrated to the product's lean, AI-native direction. Each item notes
the **market rationale** (what it matches/beats) and **who it helps**.

### Tier 1 — Close the loop on what's already scaffolded (highest ROI)

These are mostly _wiring_, not new architecture, and each unlocks
revenue or kills denials directly.

| #   | Recommendation                                                                                                                                                                                                                                                         | Why / market tie-in                                                                                                               | Helps           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | **Wire real-time eligibility (270/271)** end-to-end on the existing Office Ally SFTP rails; surface results in the existing worklist; daily refresh of active coverages.                                                                                               | Table-stakes for _every_ competitor; cuts eligibility denials 90–95% (~22% of all DME denials).                                   | DME (cash), CSR |
| 2   | **Enforce eligibility at order/confirm time.** Before creating a fulfillment (SMS `YES`, storefront, CSR), consult the cached 270/271 + Medicare **Same-or-Similar** result; if not covered / PA-required, raise a CSR ticket + message the patient _before_ shipping. | "Checks begin 28 days early so exceptions are worked." Catches misspelled member IDs / plan-year changes at minute 5, not week 3. | DME, CSR        |
| 3   | **Automate the claims loop:** scheduler submits 837P when a claim is ready; **poller** ingests 999/277CA/835 into the existing tables and posts remits.                                                                                                                | "Bills without a human touch"; faster DSO, fewer manual touches.                                                                  | DME, CSR        |
| 4   | **Bridge storefront ↔ resupply.** A `public.orders` order should create an episode/fulfillment (or merge the models) so CSRs work one queue and reorder cadence is tracked for storefront buyers too.                                                                  | One unified fulfillment queue is standard; eliminates double-entry.                                                               | CSR             |
| 5   | **Add a real HCPCS ↔ SKU/product mapping table.** Pull HCPCS out of `frequency_rules` names; key catalog, eligibility, claims, and quantity entitlement off it.                                                                                                        | Foundational plumbing that unblocks 1, 2, and quantity rules.                                                                     | DME, CSR        |

### Tier 2 — Resupply automation & patient self-service depth (the heart of the ask)

| #   | Recommendation                                                                                                                                                                                                                             | Why / market tie-in                                                                                                      | Helps                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 6   | **Rich magic-link confirmation page.** Reminder SMS/email links to a no-login page showing the patient's due items **with product images**, address-on-file, and a one-tap **Confirm / Edit / Decline**. (Reuse `RESUPPLY_LINK_HMAC_KEY`.) | The single highest-leverage feature in the market — NikoHealth: response **5%→20%**; "no app, no password" is universal. | DME (revenue), patient |
| 7   | **Multi-channel cadence with escalation.** If SMS goes unanswered → email → (opt-in) automated voice, with configurable quiet windows. Today it's one channel per scan.                                                                    | Multi-channel is how vendors hit 45–50% connection vs ~15% single-channel IVR.                                           | DME, CSR               |
| 8   | **Enforce quantity/frequency entitlement.** Use the cadence engine to block "too-soon" reorders (Medicare won't pay early) and right-size quantities.                                                                                      | Prevents the most common avoidable denial; protects the patient from a surprise bill.                                    | DME, patient           |
| 9   | **AI inbound reorder IVR.** Add a `/voice/reorder-inbound` entry to the existing OpenAI Realtime bridge: identify by DOB+ZIP, read back due items, confirm — 24/7, zero CSR labor.                                                         | Brightree Voice Services / Apria 24/7 IVR. Most of the infra already exists.                                             | DME, CSR, patient      |
| 10  | **Patient resupply self-service in `/account`.** Order history, tracking, one-tap reorder of due items, "manage my supplies" cadence view, and proactive in-app "time to reorder" nudge.                                                   | Parity with ResMed myAir / Apria myApria / Lincare SleepCircle.                                                          | patient, CSR           |
| 11  | **Smarter admin queues (auto-action the obvious).** Auto-approve low-risk RMAs; auto-send cart-abandonment; auto-retry/triage failed-email orders. (Already itemized in `process-simplification-review-2026-05-21.md` A1/A4/A7.)           | "Let your team focus on exceptions, not repetitive tasks."                                                               | CSR                    |

### Tier 3 — Clinical / RT-facing & AI differentiation

| #   | Recommendation                                                                                                                                                                                                                                                                                                  | Why / market tie-in                                                         | Helps       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| 12  | **Finish nightly therapy sync + real-time adherence alerts.** Confirm/implement the `therapy-integrations.nightly-sync` job across all four adapters; raise `csr_compliance_alerts` on usage drop / high AHI / high leak; feed the existing **RT Overview** board and auto-track the Medicare 30/90-day window. | Adherence monitoring is core RT value; protects the 90-day compliance gate. | RT, DME     |
| 13  | **Auto-enroll early-risk patients into coaching.** Heuristic first (week-1 avg usage <4 hr → 4× non-compliance risk → route to `coaching_plans`); ML later once data accrues (EnsoData-style).                                                                                                                  | Aeroflow/EnsoData differentiation; moves compliance toward 85%.             | RT, patient |
| 14  | **Patient-portal sleep-coach chatbot.** A PHI-safe Claude assistant that answers "why is my mask leaking at 2 a.m.?" using the patient's last 7-day therapy snapshot. (Reuse the existing AI plumbing.)                                                                                                         | ResMed myAir shipped "Dawn" (2025–26); materially improves adherence.       | patient, RT |
| 15  | **Predictive denial scoring (heuristic).** Surface "payer X denies E0601 without KX 38% of the time" at claim preflight, feeding the existing AI billing queue.                                                                                                                                                 | Beats incumbents; 20–30% denial reduction in published programs.            | DME, CSR    |

### Tier 4 — Revenue & cleanup (smaller, high-confidence)

| #   | Recommendation                                                                                                                                                                                                                                                                                                                                                                                    | Why / market tie-in                                                                               | Helps        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------ |
| 16  | **Cash-pay membership/subscription tier** (free shipping + % off + included Rx-renewal) on `shop_customers`.                                                                                                                                                                                                                                                                                      | Lofta WorryFree / SoClean Easy Pay; removes the insurance-friction that drives D2C patients away. | DME, patient |
| 17  | **Resupply analytics the industry expects.** Add connection rate, order/conversion rate, items-per-order, AOV, orders-per-patient-per-year, retention to the existing analytics surface (the per-touch metrics view is a head start).                                                                                                                                                             | "Measure it to manage it" — the standard resupply KPI set.                                        | DME          |
| 18  | **Audit (don't blanket-remove) the post-0156 RBAC/compliance surface.** 0156 RETAINED `audit_log` + `patient_grievances`, so `audit.*` and `grievances.*` still gate live routes (e.g. `/admin/patient-documents/retention`). Prune a permission only after confirming its domain table was actually dropped (e.g. `training.manage` → `staff_training_records`) and no role/route references it. | Avoids removing live access controls; keeps the console honest.                                   | eng          |

### Explicitly **not** recommended (respecting product direction)

- Rebuilding the dropped HIPAA/DMEPOS/ACHC machinery (BAA inventory, OIG
  LEIE, QAPI, risk assessments, audit tamper-chain) — deliberately
  retired in 0156; compliance is owner-managed out of band.
- Re-introducing column-level PHI encryption (removed in 0025) or a
  password pepper (removed in #38).
- A native mobile app / delivery-driver app — defer until a clear
  business trigger (the gap analysis already parks these).

---

## Suggested first wave

A coherent, shippable sequence that compounds:

1. **HCPCS↔SKU mapping (#5)** → unblocks eligibility, claims, quantity.
2. **Wire 270/271 + enforce at order time (#1, #2)** → kills the
   biggest denial category and protects patients from surprise bills.
3. **Magic-link confirmation page (#6)** → the proven revenue lever
   (5%→20% response) and the most visible patient-facing upgrade.

That trio is mostly wiring on top of models that already exist, targets
the two metrics that matter most (denial rate + order capture), and sets
up Tier 2/3 cleanly.

---

## Sources

**Market / competitor research (May 2026):**
[Brightree ReSupply](https://www.brightree.com/brightree-resupply/) ·
[WellSky / S3 Resupply](https://wellsky.com/dme-resupply/) ·
[NikoHealth resupply](https://nikohealth.com/medical-resupply/) ·
[Bonafide](https://www.bonafide.com/dme-hme-solutions/) ·
[DME Flow](https://www.dmeflow.ai/resupply-automation) ·
[HME News — Resupply benchmarks](https://www.hmenews.com/article/resupply-establish-benchmarks-goals) ·
[ACU-Serve — outsourcing CPAP resupply](https://acuservecorp.com/outsourcing-cpap-resupply/) ·
[ResMed — when to replace CPAP supplies](https://www.resmed.com/en-us/sleep-health/blog/when-to-replace-cpap-supplies/) ·
[CPAPsupplies — replacement schedule](https://cpapsupplies.com/cpap-replacement-schedule) ·
[CallSphere — AI voice agents for medical-device adherence](https://callsphere.ai/blog/ai-voice-agents-medical-device-companies-patient-onboarding-adherence) ·
[Jindal HC — AI eligibility verification 2026](https://www.jindalhc.com/thought-leadership/why-dme-providers-cant-risk-going-into-january-2026-without-ai-eligibility-verification)

**Codebase inventory:** 190 SQL migrations in `lib/resupply-db/drizzle/`
(esp. 0070, 0118, 0128–0156); `artifacts/resupply-api/src/` routes +
worker jobs; `artifacts/cpap-fitter/src/pages/{,admin/}`;
`lib/resupply-{reminders,domain,ai,integrations*}`; prior internal docs
[`competitive-gap-analysis-2026-05-19.md`](./competitive-gap-analysis-2026-05-19.md) and
[`process-simplification-review-2026-05-21.md`](./process-simplification-review-2026-05-21.md).
