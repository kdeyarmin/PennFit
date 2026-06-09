# PennFit App Review & Enhancement Roadmap — Customer UX & Growth · Resupply Automation · Clinical/Billing Depth — 2026-06-09

**Audience:** Penn Home Medical Supply ownership + engineering.
**Goal:** Review what the app does end to end, then recommend enhancements
through three lenses the owner asked to prioritize: **(A) customer UX &
growth**, **(B) core resupply automation**, and **(C) clinical & billing
depth**.
**Method:** Full code-grounded inventory of all five product surfaces
(storefront SPA, admin console, in-process worker + voice agent, AI/
integrations, billing/RCM), cross-checked against the existing `docs/` review
corpus and verified against current code on the working branch. No application
behavior is changed by this document.

> **How this differs from the existing docs.** The repo already has an
> excellent, code-verified internal-persona review set — most recently
> [`feature-review-and-gap-research-2026-06-07.md`](./feature-review-and-gap-research-2026-06-07.md)
> and [`dme-app-improvements-2026-06-06.md`](./dme-app-improvements-2026-06-06.md)
> — that maps the open work for **owners, CSRs, billers, and RTs**. Those remain
> the system of record for the internal-persona backlog. This document does
> **not** re-derive them. Its original contribution is the **patient-facing
> customer-experience and growth funnel**, which the existing corpus barely
> touches; it then re-prioritizes the already-identified automation and
> clinical/billing items _through the funnel/growth lens_. Items already shipped
> are called out so finished work is not re-funded.

---

## 1. Function review — what PennFit is today

PennFit is a broad, production-grade DME/CPAP-resupply platform, **~90–95%
feature-complete** against the commercial DME-resupply market (Brightree
ReSupply, WellSky/S3, NikoHealth). The five surfaces:

| Surface                  | What it does                                                                                                                                                                                                                                                   | Maturity read                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Storefront SPA**       | ~60 patient pages: privacy-first on-device mask fitter (MediaPipe; images never transmitted), insurance order flow, cash-pay Stripe shop, 30+ SEO/education pages, a signed-in account hub, chatbot + sleep coach, reminders self-service.                     | Broad and polished; **growth instrumentation is captured but not surfaced** (see §3).               |
| **Admin console**        | ~115 pages / ~150 routes: patient 360, omnichannel inbox with SLA routing, RT clinical board, a full X12 5010 billing suite, shop/inventory ops, analytics, configuration & feature flags.                                                                     | Deep and largely REAL, not scaffolding.                                                             |
| **Worker + voice agent** | ~50 pg-boss jobs (cadence reminder scan, smart-trigger evaluator/send, escalation, win-back, lifecycle, nightly therapy sync, billing sweeps) + a live OpenAI-Realtime↔Twilio voice agent with Claude post-call summary.                                       | Strong; several high-value jobs are **built but dormant** behind flags/env.                         |
| **AI / integrations**    | Claude/OpenAI provider selection with offline-safe fallback; storefront chatbot, sleep coach, SMS classifier, email auto-reply, AI claim scrubber + denial analyzer; four therapy-cloud feeds (ResMed AirView, Philips Care, 3B/React Health, Health Connect). | Excellent; live ResMed/Philips data is **contract-gated** (BAAs), not code-gated.                   |
| **Billing / RCM**        | 837P generation + SFTP, 835 ERA parse + auto-post, 270/271 eligibility (incl. 271 inbound auto-processing), Da Vinci PAS, capped-rental automation, PA/DWO expiry sweeps, denial catalog, collections forecast.                                                | ~70% REAL; last-mile gaps in **outbound fax, 276/277 status, and form-PDF generation** (per 06-07). |

The honest summary: **the basics are built.** The remaining opportunity is to
(A) convert the strong feature set into measured patient growth, (B) _activate_
automation that already exists, and (C) close the billing last mile and deepen
clinical tooling.

---

## 2. Maturity legend

| Tag                      | Meaning                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| ✅ **Shipped**           | Built and wired. Listed only to prevent re-funding.                                                 |
| 🟡 **Built-but-dormant** | Code exists; blocked on an _activation decision_, _consent/policy_, or _partner_ — not engineering. |
| 🔴 **Open**              | Genuinely not built; needs new code.                                                                |
| ⚪ **Deferred**          | Deliberately parked pending a business trigger.                                                     |

---

## 3. Focus A — Customer UX & Growth (the under-served lens)

CPAP supplies are a **recurring-revenue annuity**, and the category lives or
dies on outreach + frictionless confirmation + retention. The benchmarks below
are from the market research already in the repo
([`dme-resupply-automation-research-and-recommendations-2026-05-30.md`](./dme-resupply-automation-research-and-recommendations-2026-05-30.md)):
magic-link confirmation lifts response **5% → 20%**; managed outreach reports
**45–50% order rates** at **~$175 AOV**; automated programs publish **+42% items
per order** and **+46–50% revenue per order**. PennFit has the machinery to hit
these numbers; the gap is **measurement and a few activation decisions**, not
features.

Walking the patient journey, with a code-anchored lever per stage:

| Stage                        | What exists                                                                                                                                                                                                                                                                                                                                                                  | Maturity       | Recommended lever                                                                                                                                                                                                                                                                                                                                                           | Effort        | Anchor                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| **G1 — Funnel visibility**   | The full fitter + shop funnel is instrumented client-side: `track()` posts ~25 typed steps (`home_view`→`consent_given`→`capture_taken`→`measurements_extracted`→`questionnaire_completed`→`results_viewed`→`mask_chosen`→`order_started`→`order_submitted_success`, plus shop `checkout_*` and chat events) to `/api/usage-events`, persisted in `usage_events` (mig 0027). | 🔴 (surfacing) | **The events are captured but never surfaced.** No admin route or page reads `usage_events`. Build a storefront/fitter **acquisition-funnel drop-off dashboard** (step-to-step conversion, by source/day) reading `usage_events`. This is the single highest-leverage growth item: you cannot improve a funnel you cannot see.                                              | S–M           | client `lib/track.ts`; ingest `routes/storefront/usage-events.ts`; table mig `0027`; **no reader exists** |
| **G2 — Acquisition / SEO**   | 30+ `learn-*`/`help-*` pages, brand spotlights, quiz-lead + insurance-lead capture, fitter-invite links.                                                                                                                                                                                                                                                                     | ✅ / 🔴        | Content is broad. Open: tie lead-capture (`shop/quiz-lead`, `insurance-lead`) into the G1 dashboard so SEO/content ROI is attributable, and review which `learn` pages actually feed the fitter CTA.                                                                                                                                                                        | S             | `pages/learn-*.tsx`, `routes/shop/{quiz-lead,insurance-lead}.ts`                                          |
| **G3 — Fitter→order conv.**  | Consent gate + step guards (`/measure` needs capture, `/results` needs answers, `/order` needs a chosen mask); abandoned-fitter recovery jobs `fitter-lead-first-day-nudge`, `-reengage`, `-supply-campaign` (6-touch over 60 days).                                                                                                                                         | ✅             | Recovery is strong. With G1 live, A/B the consent gate and the results→order step (the two guarded transitions most likely to leak) and watch `consent_given`→`mask_chosen`→`order_submitted_success` conversion move.                                                                                                                                                      | S (post-G1)   | `App.tsx` guards; `worker/jobs/fitter-lead-*.ts`                                                          |
| **G4 — Checkout / pay**      | Stripe Hosted Checkout, `quick-checkout` for returning buyers, cart cross-sell, recently-viewed, HSA/FSA badge.                                                                                                                                                                                                                                                              | ✅ / 🔴        | **Patient financing / BNPL** (tracked as B7 in 06-07 as a _billing_ item) is also a **conversion** lever — installment options lift upfront collections ~25% as patient responsibility rises. Pull it forward. Also: account "billing" payment methods are display-only v1 (`account-billing.tsx:146` — "pay everything"); a saved-card path would speed reorders.          | M             | `pages/account-billing.tsx`, `patient_payment` + Stripe                                                   |
| **G5 — Account engagement**  | Rich signed-in hub: therapy summary, reorder suggestions, education feed, insights, wallet pass, web push, biometric sign-in, caregiver access, comm prefs.                                                                                                                                                                                                                  | ✅ / 🟡        | The hub is excellent. **The single biggest recurring-revenue lever is dormant:** `storefront.auto_reminder_enrollment` auto-enrolls cash-pay buyers into replacement reminders — built, opt-out-safe (email-only, unsubscribe token, never re-enrolls a prior unsubscribe), **seeded DISABLED pending a CAN-SPAM/consent decision**. This is a _policy_ decision, not code. | XS (decision) | `lib/storefront/order-reminder-enrollment.ts:13,141`                                                      |
| **G6 — Retention / reorder** | Data-driven smart-triggers (3–5× lift vs calendar reminders), reminder escalation, lapsed-customer win-back, lifecycle/birthday touchpoints, quarterly therapy summaries, delivery follow-up.                                                                                                                                                                                | ✅ / 🟡        | Mostly shipped. Turn on the dormant cart-abandonment cron (C4, gated `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED`, seeded off) and review closed-loop attribution (`analytics/outreach-attribution.ts`) so retention spend is measured.                                                                                                                                         | XS–S          | `worker/jobs/{cart-abandonment-scan,smart-trigger-*,lapsed-customer-winback}.ts`                          |
| **G7 — Referral / advocacy** | Referral program + NPS survey both exist (`/nps`, referral-program-section).                                                                                                                                                                                                                                                                                                 | 🔴             | The loops aren't closed: wire **NPS-promoter → review-request** and **NPS/referral → reward** measurement so advocacy is a tracked channel in LTV/CAC, not a standalone page.                                                                                                                                                                                               | S             | `routes/shop/nps-response.ts`, referral-program-section, `analytics/ltv-cac.ts`                           |

**Takeaway for A:** PennFit already _does_ the growth motions; it just can't
_see_ them. Ship the **G1 funnel dashboard** first (the data is already being
collected), make the **G5 consent decision** to unlock recurring-revenue
capture, then use G1 to drive the G3/G4/G7 conversion work.

---

## 4. Focus B — Core resupply automation

Lead-in: **most of the resupply pipeline is already built.** The
storefront→resupply reorder bridge (`order-reminder-enrollment.ts`), the
hourly cadence scan with Medicare-LCD timing, multi-channel TCPA-gated outreach,
inbound `YES/EDIT/STOP` + AI intent fallback, the order-time eligibility
coverage guard (`order-flow.ts`, raises `resupply_coverage_blocked` instead of
auto-shipping), and 271 inbound auto-processing are all shipped and verified
(see the "already shipped" lists in 06-06/06-07). The activation runbook is
[`docs/runbooks/activate-dormant-growth-jobs.md`](./runbooks/activate-dormant-growth-jobs.md).

The genuinely-open / activation items:

| #   | Item                                         | Maturity | Why it matters                                                                                                                                                                                                                               | Effort        |
| --- | -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| B-1 | Activate auto-reminder enrollment (= G5)     | 🟡       | The recurring-revenue annuity capture lever; XS flag flip after a consent decision.                                                                                                                                                          | XS (decision) |
| B-2 | Activate cart-abandonment + escalation crons | 🟡       | Built jobs seeded off; shift CSRs from dialing to exception-handling.                                                                                                                                                                        | XS (flags)    |
| B-3 | **276/277 claim-status inquiry**             | 🔴       | The eligibility loop (270/271) is closed; the _claim-status_ loop is not — billers wait for the ERA instead of proactively asking "where's my claim?" (carries over from 06-07 B3).                                                          | M             |
| B-4 | Resupply→fulfillment→claim "no-touch" review | ✅/🔴    | Document which transitions are truly hands-off vs. still a deliberate human click (auto-_submitting_ claims is intentionally gated). Reference [`backend-dme-efficiency-audit-2026-06-02.md`](./backend-dme-efficiency-audit-2026-06-02.md). | S (doc)       |

**Takeaway for B:** the highest-ROI automation work is **turning on what's
already built** (B-1, B-2) — a runtime/consent activation, not engineering.

---

## 5. Focus C — Clinical & billing depth

These consolidate the still-open items from the 06-07 persona tables, cited
rather than re-derived. (06-07 corrections stand: 271 auto-processing,
therapy-grounded sleep coach, A/R aging, intervention outcome measurement, and
the billing action-queue roll-up are **shipped** — do not list as open.)

### Billing last mile

| #    | Gap                                         | Maturity  | Why it matters                                                                                                                | Effort | Anchor (per 06-07)              |
| ---- | ------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------- |
| C-B1 | **Outbound fax** (appeals, non-FHIR PA/DWO) | 🔴        | The single biggest hole — ~40% of payers still require fax; the app renders a perfect PDF, then the biller leaves to send it. | M      | `routes/admin/claim-appeals.ts` |
| C-B2 | **CMN / DWO / SWO PDF generation**          | 🔴 (STUB) | Expiry is tracked but forms are hand-made outside the app; blocks oxygen/RAD line expansion. Reuse the HCFA pdfkit path.      | M      | `routes/admin/dwo-documents.ts` |
| C-B3 | **Patient financing / BNPL** (= G4)         | 🔴        | Conversion + collections lever as patient responsibility rises.                                                               | M      | `patient_payment` + Stripe      |

### Clinical / RT

| #    | Gap                                        | Maturity        | Why it matters                                                                                                                             | Effort         | Anchor (per 06-07)                                        |
| ---- | ------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------- |
| C-R1 | **RT cohort / bulk-campaign tooling**      | 🔴              | No "assign all high-leak ResMed patients to a mask-refit program"; outreach is per-patient or a fixed cron.                                | M              | `lib/clinical/clinical-outreach.ts`                       |
| C-R2 | **Unified clinical comms timeline**        | 🔴              | Encounters and SMS/email live in separate tables; an RT can't see "texted Tue, replied Wed" in the clinical record.                        | M              | `clinical-encounters.ts` + `conversations/*`              |
| C-R3 | **HSAT (home sleep test) in-funnel order** | 🔴 (+ partner)  | Closes "I might have apnea" → prescribed CPAP in ~72h; a top-of-funnel **acquisition** play (ties to Focus A).                             | M + partner    | `routes/patients/sleep-studies.ts`                        |
| C-R4 | **ML adherence model**                     | 🟡 (data-gated) | Heuristic scorer is fine for triage; an ML model needs ~1k+ accumulated therapy records first.                                             | L (data-gated) | `lib/clinical/adherence-predictor.ts`                     |
| C-R5 | **Live ResMed/Philips data (BAA)**         | 🟡 (contract)   | Adapters are production-quality but gated on executed partner BAAs/OAuth — gates the whole adherence pillar. Track as a _business_ action. | — (contract)   | `lib/resupply-integrations-airview`, `-care-orchestrator` |

### Cross-cutting performance at scale

From [`performance-review-2026-06-05.md`](./performance-review-2026-06-05.md)
and 06-06 §6 — matters as patient/claim volume grows, and especially before
turning on more automation:

- **~68 `count: 'exact'` calls across 34 files** on hot dashboard tables → switch
  to `'estimated'` where an approximate badge count is acceptable.
- **Missing billing indexes** on hot queries (e.g. `insurance_claims(decision_at)`,
  `(status, submitted_at)`).
- **`.limit(20000)` in-memory aggregation caps** in `ltv-cac.ts`,
  `billing-director.ts`, `analytics.ts`, `mask-fit-worklist.ts` → push aggregation
  into SQL RPCs so totals stay correct past the cap.

---

## 6. Recommended sequencing

ROI-ordered across the three lenses. Items are tagged by what kind of work they
are, because several of the highest-value ones are **decisions, not code**.

**Wave 0 — decisions & flag flips (no engineering)**

1. **G5/B-1 — make the auto-reminder-enrollment consent decision** and flip
   `storefront.auto_reminder_enrollment`. Biggest recurring-revenue lever, zero new code.
2. **B-2 — turn on the cart-abandonment + escalation crons.** Built and seeded off.

**Wave 1 — quick wins (S)**

3. **G1 — storefront/fitter acquisition-funnel dashboard** reading the
   already-collected `usage_events`. Unlocks every other growth decision.
4. **G7 — close the NPS→review and referral→reward loops** into LTV/CAC.
5. **Performance `count:'exact'`→`'estimated'`** on hot dashboards + add the two
   missing billing indexes.

**Wave 2 — builds (M)**

6. **C-B1 outbound fax** (appeals + non-FHIR PA/DWO) — stops billers leaving the app.
7. **C-B2 CMN/DWO/SWO PDF generation** — reuse the HCFA pdfkit path; enables oxygen/RAD.
8. **B-3 276/277 claim-status inquiry** — closes the claim-status loop.
9. **G4/B-3 patient financing / BNPL** — conversion + collections lever.
10. **C-R2 unified clinical comms timeline** + **C-R1 RT cohort tooling**.

**Wave 3 — differentiators & data/partner-gated**

11. **C-R3 HSAT in-funnel order** (partner-gated) — vertical-integrate acquisition.
12. **C-R4 ML adherence model** once ~1k+ therapy records accumulate.
13. Track **C-R5 ResMed/Philips BAA** as a standing business action — it gates the
    entire live-adherence pillar.

---

## 7. Reliability sidebar (brief — not a chosen focus, but a precondition)

Turning on more automation (Waves 0–1) raises the cost of an untested job or an
unverified funnel. The repo's own reviews note **only 3 Playwright e2e specs**
(storefront load, a11y, results resilience — no auth/checkout/admin flows) and
**~52 of ~96 worker jobs without tests**. Recommendation: before activating the
dormant revenue jobs, add a thin e2e happy-path for **checkout** and
**fitter→order**, and unit tests for the specific jobs being switched on
(cart-abandonment, auto-reminder-enrollment). This is a small, targeted ask — not
a coverage program.

---

## 8. Sources

### Prior internal reviews (built on, not duplicated)

- [`feature-review-and-gap-research-2026-06-07.md`](./feature-review-and-gap-research-2026-06-07.md) — system of record for the internal-persona open lists (B/R/C/O items).
- [`dme-app-improvements-2026-06-06.md`](./dme-app-improvements-2026-06-06.md) — code-verified shipped/dormant/open tags; performance §6.
- [`dme-resupply-automation-research-and-recommendations-2026-05-30.md`](./dme-resupply-automation-research-and-recommendations-2026-05-30.md) — market benchmarks cited in §3.
- [`backend-dme-efficiency-audit-2026-06-02.md`](./backend-dme-efficiency-audit-2026-06-02.md), [`performance-review-2026-06-05.md`](./performance-review-2026-06-05.md), [`growth-compliance-review-2026-06-05.md`](./growth-compliance-review-2026-06-05.md), [`competitive-gap-analysis-2026-05-19.md`](./competitive-gap-analysis-2026-05-19.md), [`feature-roadmap-2026-05-31.md`](./feature-roadmap-2026-05-31.md).

### Code anchors verified this pass

- Funnel: `artifacts/cpap-fitter/src/lib/track.ts`, `artifacts/resupply-api/src/routes/storefront/usage-events.ts`, `usage_events` (mig `0027`) — instrumented end to end, **no admin reader**.
- Dormant levers: `artifacts/resupply-api/src/lib/storefront/order-reminder-enrollment.ts` (`storefront.auto_reminder_enrollment`, seeded disabled), `worker/jobs/cart-abandonment-scan.ts`.
- Account payment v1: `artifacts/cpap-fitter/src/pages/account-billing.tsx`.
- Funnel guards + recovery: `artifacts/cpap-fitter/src/App.tsx`, `worker/jobs/fitter-lead-*.ts`.

_Review/research only. No application behavior was changed by this document._
