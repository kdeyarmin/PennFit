# PennFit improvement opportunities for DME owners, RTs & CSRs — 2026-06-06

**Audience:** Penn Home Medical Supply ownership + engineering.
**Method:** Full feature inventory of all five product surfaces (storefront,
admin console, in-process worker + voice agent, AI/integrations, cross-cutting),
**verified against current code on `origin/main`** rather than trusting the
fast-moving planning docs in `docs/`. Several items those docs list as "open"
are already shipped — they are called out so we don't re-fund finished work.

> Companion to (not a replacement for) the 2026-05-30 resupply-automation
> research and the 2026-05-31 feature review. This doc re-scopes *all three
> internal personas* against what is actually in the tree today and tags every
> item by maturity so owners can tell "already built" from "genuinely open."

---

## 1. What PennFit is today

PennFit is a broad, production-grade DME resupply platform — not a single-purpose
tool. It pairs a **privacy-first at-home CV mask fitter** (on-device MediaPipe
facial measurement; images never transmitted) with a **D2C storefront** (Stripe
catalog/cart/checkout, subscriptions, wishlist, reviews/NPS, Apple Wallet), a
**resupply outreach engine** (hourly Medicare-LCD cadence scan, TCPA-gated
SMS/email, inbound `YES/EDIT/STOP` + AI intent fallback, multi-touch escalation),
an **AI voice agent** (OpenAI Realtime ↔ Twilio bridge, 7 identity-gated tools,
inbound *and* outbound, Claude post-call summary), a **~99-page admin console /
140+ endpoints** (patient 360, conversations inbox with SLA routing, RT clinical
board, a full **X12 5010 billing suite** — 837P/835/277CA/999, 270/271 eligibility,
ERA posting, denial catalog, AI denial analyzer, capped-rental automation, PA/DWO
expiry sweeps, Da Vinci PAS), **3 live therapy-cloud integrations** (ResMed
AirView, Philips Care Orchestrator, 3B/React Health), and **~48 background jobs**.

**Maturity verdict: ~90–95% feature-complete against the DME resupply market.**
The team has executed most of its own roadmap. The highest-value work left is
therefore the *next layer*: **activating what's already built**, **a few genuinely
new workflows**, and **performance + regulatory readiness at scale** — not basics.

---

## 2. Maturity legend

| Tag | Meaning |
| --- | ------- |
| ✅ **Shipped** | Already built and production-wired. Listed only to prevent re-funding. |
| 🟡 **Built-but-dormant** | Code exists; blocked on an *activation decision*, *data volume*, or a *partner contract* — not on engineering. |
| 🔴 **Open** | Genuinely not built; needs new code. |
| ⚪ **Deferred** | Deliberately parked pending a business trigger. |

**Already shipped — do NOT re-recommend** (each verified at the cited location):
- HTTP response compression — `artifacts/resupply-api/src/app.ts:65`.
- Mask-fit feedback loop is **fully wired** — `lib/storefront/mask-fit-tuning.ts`
  feeds `recommendationEngine.ts:842` (`fitMultiplier = fitAdjustments[mask.id]`).
- Storefront→resupply reorder bridge — `lib/storefront/order-reminder-enrollment.ts`.
- Denials worklist (`routes/admin/denials-worklist.ts`), A/R aging, collections
  forecast, timely-filing, good-faith-estimates, capped-rental cycles, PECOS sync.
- 270/271 round-trip, inbound reorder IVR, Da Vinci PAS submit, nightly therapy
  sync, PA expiry sweep, AI denial analyzer — all present and wired.

---

## 3. DME company owners

Owners care about **cash, denial rate, recurring-revenue capture, and visibility**.

| # | Opportunity | Maturity | Why it helps the owner | Effort | Key files |
| - | ----------- | -------- | ---------------------- | ------ | --------- |
| O1 | **Turn on storefront auto-reminder enrollment.** A paid cash-pay order can auto-enroll the buyer in replacement reminders. Code is done and opt-out-safe but flag-gated `storefront.auto_reminder_enrollment` and seeded **disabled** pending a CAN-SPAM/consent decision. | 🟡 | Recurring-revenue annuity capture — the single biggest lever in the resupply market — with zero new code; needs an owner consent-policy sign-off. | XS (decision + flag) | `lib/storefront/order-reminder-enrollment.ts:141` |
| O2 | **Insurance estimate that learns from real outcomes.** The patient-facing OOP estimate is a static ~11-row `PAYER_ESTIMATES` table; real `insurance_claims` + paid amounts can compute P50/P90 patient responsibility per (payer, SKU). | 🔴 | Higher checkout conversion + fewer "surprise bill" complaints; turns a guess into a data-backed range. | M | `lib/insurance-estimates/data.ts:29`, `routes/shop/insurance-estimate.ts` |
| O3 | **Predictive denial scoring at claim preflight.** The denial-code catalog, AI denial analyzer, and claim history already exist — surface "payer X denies E0601 without KX 38% of the time" *before* submission, feeding the existing AI billing queue. | 🔴 | Directly cuts the denial rate (~2–5% of DME revenue in write-offs/rework) and DSO. | M | `lib/billing/claim-preflight.ts`, `lib/billing/ai-denial-analyzer.ts` |
| O4 | **Resupply KPI benchmark tiles.** Add the industry-standard set — connection rate, order/conversion rate, items-per-order, AOV, orders-per-patient-per-year, retention — to the existing analytics surface (per-touch metrics are a head start). | 🔴 | "Measure it to manage it"; lets the owner benchmark against published resupply norms. | M | `routes/admin/analytics.ts`, `routes/admin/control-center.ts` |
| O5 | **Performance at scale** (see §6). | 🔴 | Keeps admin dashboards fast as patient/claim volume grows. | S–M | see §6 |
| O6 | Native owner/manager mobile app. | ⚪ | Deferred — no business trigger yet; the SPA + Apple Wallet cover today's need. | — | — |

---

## 4. Respiratory therapists (clinical staff)

RTs care about **adherence visibility, targeted intervention, and not chasing
paperwork**. Note: the strongest RT items are *activation/data* problems, not
missing code — the clinical engine is built.

| # | Opportunity | Maturity | Why it helps the RT | Effort | Key files |
| - | ----------- | -------- | ------------------- | ------ | --------- |
| R1 | **Unblock live ResMed/Philips device data.** Adapters are production-quality but their endpoints/OAuth are gated on executed partner BAAs. Until then, adherence monitoring, smart-triggers, the RT board, and coaching plans all run on 3B/patient-push data only. | 🟡 (contract) | This single blocker gates a whole value pillar — the RT's entire adherence workflow depends on it. Worth tracking explicitly as a business action. | — (contract) + S (config) | `lib/therapy-cloud/index.ts`, `lib/resupply-integrations-airview`, `-care-orchestrator` |
| R2 | **Sleep coach grounded in real therapy data.** The PHI-safe Claude sleep coach exists; feed it the patient's last-7-day therapy snapshot so it can answer "why is my mask leaking at 2 a.m.?" with real numbers. | 🟡 (depends on R1 data) | Materially improves adherence (cf. ResMed myAir "Dawn"); offloads routine RT questions. | S–M | `lib/clinical/sleep-coach`, `routes/shop/me-therapy-summary.ts` |
| R3 | **Auto-enroll early-risk patients into coaching.** Heuristic first: week-1 average usage < 4 hr → ~4× non-compliance risk → auto-route to `coaching_plans` and the RT intervention queue. | 🔴 | RTs spend clinical time on the patients most likely to quit, *before* the Medicare 90-day window closes. | M | `worker/jobs/coaching-plan-progress.ts`, `routes/admin/interventions.ts`, `lib/resupply-domain` (heuristic) |
| R4 | **Mask-fit tuning visibility nudge.** The feedback loop is wired but neutral below 10 outcomes/mask; add an RT-facing "N more fits until this mask earns a ranking adjustment" indicator so the data-accrual is legible rather than invisible. | 🟡 | Makes a working-but-silent feature observable; encourages outcome capture that improves recommendations. | XS–S | `lib/storefront/mask-fit-tuning.ts`, `routes/admin/mask-fit-worklist.ts:142` |

---

## 5. Customer-service reps (CSRs)

CSRs care about **working a triaged queue instead of a phone book, full context
in one screen, and less manual data entry**.

| # | Opportunity | Maturity | Why it helps the CSR | Effort | Key files |
| - | ----------- | -------- | -------------------- | ------ | --------- |
| C1 | **Patient dedup / merge.** Only `pacware_id` uniqueness is enforced; fax/referral intake produces variant spellings with no fuzzy (name+DOB+phone) match or guarded merge workflow. | 🔴 | Kills the most common DME data-hygiene headache; one clean patient record instead of three. | M | `routes/patients/create.ts`, `routes/patients/` (new merge endpoint) |
| C2 | **Inbound fax → structured referral (OCR).** Faxes land in a `new` queue but are hand-triaged into patient/referral records. OCR + parse (the dominant DME intake channel) into a draft referral. | 🔴 | Removes the heaviest manual data-entry step in DME intake. | M–L | `routes/admin/inbound-faxes.ts` |
| C3 | **Real-time staffing / queue dashboard.** Today's productivity metrics are *lagging* (closed-this-week, snapshots). Add a live "which CSR is overloaded right now," plus voice-queue wait/handle time (the full voice stack already emits the events). | 🔴 | Lets a lead rebalance load mid-shift; surfaces the voice queue that's otherwise invisible. | M | `routes/admin/productivity.ts`, `today.ts`, `work-items.ts` |
| C4 | **Auto-action the obvious queues.** Turn on the **already-built** cart-abandonment cron (gated `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED`, seeded off), auto-approve low-risk RMAs, and ship a daily failed-order-email digest. | 🟡 / 🔴 (mixed) | Shifts CSRs from repetitive dialing to exception resolution — the core promise of resupply automation. | XS (flag) + S (RMA rules) | `worker/jobs/cart-abandonment-scan.ts:439` (worker/index.ts), `routes/admin/shop-returns.ts` |
| C5 | **Eligibility coverage guard at order/confirm time.** The 270/271 loop now lands a parsed coverage row, but `getCachedEligibility()` isn't consulted before a fulfillment is created — a patient can confirm an SMS reorder with inactive/PA-required coverage. Add a fail-open, flag-gated guard that raises a CSR alert instead of auto-shipping. | 🔴 | Catches misspelled member IDs / plan-year changes at minute 5, not week 3 — fewer denials land back on the CSR. | M | `lib/messaging/order-flow.ts`, `routes/admin/eligibility-checks.ts` |

---

## 6. Cross-cutting: performance at scale (owner-relevant)

Verified against current code; matters as patient/claim volume grows.

- **~68 `count: 'exact'` calls across 34 files** on unbounded hot tables — Postgres
  scans every row instead of an O(1) planner estimate. Worst offenders on admin
  dashboards: `routes/admin/inbox-counts.ts` (7), `billing-director.ts` (4),
  `analytics-revenue-by-source.ts` (3), `ops-status.ts` (3), `insurance-leads.ts` (4),
  `customers.ts`. **Fix:** switch to `'estimated'` only where an approximate total is
  acceptable (badge counts, "~N results") — keep `'exact'` where a route genuinely
  needs the precise number.
- **Missing billing indexes** on hot queries (e.g. `insurance_claims(decision_at)` for
  the 90-day denial trend, `(status, submitted_at)` for stuck-submitted). Add via a new
  hand-written migration following the prefix convention in `lib/resupply-db/drizzle/`.
- **In-memory aggregation with silent truncation caps** (`.limit(20000)`) in
  `ltv-cac.ts`, `billing-director.ts`, `analytics.ts`, `mask-fit-worklist.ts`. Push
  aggregation into SQL RPCs so totals stay correct past the cap.

---

## 7. Regulatory horizon 2026–2028 (owner-relevant, plan-ahead)

Not bugs — forward-looking compliance items an owner should schedule. (PennFit
deliberately retired in-app HIPAA/DMEPOS/ACHC machinery in migration 0156;
compliance is handled out of band, so these are mostly *operational* with a thin
code surface.)

- **Annual DMEPOS accreditation resurveys** (unannounced, effective Jan 1 2026).
- **HIPAA Security Rule NPRM** (finalizes 2026–27): likely mandates encryption at
  rest, MFA for all staff, biannual vuln scans, annual pen tests.
- **Good-faith-estimate** for cash-pay patients (No Surprises Act) — a GFE route
  already exists (`routes/admin/good-faith-estimates.ts`); confirm coverage.
- **HITRUST r2 / SOC 2 Type II** if payer procurement requires it.

---

## 8. Recommended first implementation wave

A coherent, high-ROI sequence touching all three personas, mostly small:

1. **O1 — activate storefront auto-reminder enrollment** (owner): an XS flag flip
   after a consent decision unlocks recurring-revenue capture with zero new code.
2. **C4 — auto-action obvious queues** (CSR): turn on the built cart-abandonment
   cron + a failed-order digest; immediate CSR-labor relief.
3. **C5 — eligibility coverage guard at order time** (CSR/owner): kills the biggest
   avoidable denial category and protects patients from surprise bills.
4. **O3 — predictive denial scoring at preflight** (owner): builds on the existing
   AI billing stack; visible denial-rate impact.
5. **R3 — auto-enroll early-risk patients into coaching** (RT): a heuristic that
   protects the Medicare 90-day adherence window.

Items 1–2 are near-free activations; 3–5 are scoped new code that reuses existing
models and utilities. **Pick the items you want and I'll implement them one focused,
tested change at a time.**
