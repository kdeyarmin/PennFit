# PennFit Growth & Compliance Review — 2026-06-05

A whole-app review aimed at three business goals:

1. **Sell more supplies.**
2. **Identify non-compliant CPAP patients sooner.**
3. **Keep in touch with those patients to get them up to insurance
   compliance** — so the rental stays billable.

> **TL;DR.** PennFit is already a remarkably complete system. Roughly **50
> scheduled jobs** implement nearly every best-practice DME growth/compliance
> pattern. The biggest opportunities are **not** building new features — they
> are (a) **turning on machinery that's already built but dormant**,
> (b) making compliance detection **accurate per insurance payer** instead of
> Medicare-only, and (c) **measuring** whether outreach actually drives orders
> and compliance. This document is a map and a roadmap. It changes **no app
> behavior**.

---

## 1. Executive summary

The instinct on a request like this is to design new features. After a thorough
read of the codebase, that would mostly **re-create things that already exist**.
The system already has win-back, abandoned-cart recovery, a Nov→Jan-1
"use-your-benefits" deductible push, multi-touch nurture campaigns, nightly
multi-cloud therapy ingestion, the Medicare 90/30 compliance computation, an
at-risk worklist, adherence prediction, a voice agent, a sleep coach, and bulk
campaigns.

So the real opportunity is in three places:

| Theme                  | One-line summary                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Activation**         | High-value jobs exist but are **gated OFF** by default flags/env vars. Turning them on is mostly a config + consent decision, not engineering.      |
| **Per-payer accuracy** | Compliance is **hard-coded to the Medicare rule** (≥4h on ≥21 of 30 nights). Non-Medicare payers are misclassified, so we flag the wrong patients. |
| **Measurement**        | We send a lot of outreach but **can't see which of it converts** to orders or compliance improvement. No closed-loop attribution.                   |

### Scoreboard

| Business goal                    | Already built & ON                                                                                                         | Built but **dormant**                                                                                                                                        | Genuine gap                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **Sell more supplies**           | Storefront + Subscribe & Save, reorder suggestions, cart cross-sell, win-back, delivery follow-up, deductible-reset push   | Cart-abandonment **auto**-sweep, fitter supply campaign, reminder escalation, auto-enroll storefront buyers in reminders, failed-order-email recovery digest | Revenue-by-source & outreach→order attribution              |
| **Detect non-compliance sooner** | Nightly therapy ingest, CMS 90/30 setup-adherence, fleet overview + worklist, adherence predictor, onboarding at-risk scan | Therapy-fleet auto-outreach, clinical-outreach batch cron                                                                                                    | **Per-payer thresholds** (today Medicare-only)              |
| **Keep in touch to compliance**  | Reminders, smart triggers, voice agent, sleep coach, coaching plans, milestones                                            | Therapy-fleet adherence SMS, reminder escalation, clinical-outreach batch                                                                                    | **Deadline-aware escalating** outreach as day-90 approaches |

---

## 2. What already exists (capability inventory)

This section exists so the team can see what they already own before building
anything. All paths are real and current as of this review.

### 2.1 Sell more supplies

- **Storefront & checkout** — Stripe-backed catalog with **one-time and
  Subscribe & Save** pricing. `artifacts/resupply-api/src/routes/shop/`
  (`products.ts`, `checkout.ts`, `my-subscriptions.ts`).
- **Resupply cadence engine** — `frequency_rules` table (seeded with Medicare
  DMEPOS replacement schedules), resolved three-tier (per-patient override →
  payer/SKU rule → prescription fallback) in
  `lib/resupply-domain/src/outreach-plan.ts`. **Already keys on insurance
  payer** via `frequency_rules.match_insurance_payer`.
- **Reorder suggestions** — `/shop/me/reorder-suggestions` +
  `artifacts/cpap-fitter/src/components/reorder-suggestions-section.tsx`.
- **Cart cross-sell** — "complete your setup" strip,
  `artifacts/cpap-fitter/src/components/shop/cart-cross-sell.tsx`.
- **Lifecycle & win-back jobs** (`artifacts/resupply-api/src/worker/jobs/`):
  `lapsed-customer-winback.ts`, `cart-abandonment-scan.ts`,
  `deductible-reset-push.ts` (fires in November: "use your benefits before
  Jan 1"), `fitter-supply-campaign.ts` (6-touch post-fitting nurture),
  `shop-order-delivery-followup.ts`, `low-stock-alerts.ts`,
  `lifecycle-touchpoints.ts` (birthday/anniversary),
  `quarterly-therapy-summary.ts`.

### 2.2 Detect non-compliance sooner

- **Therapy ingestion** — `therapy-integrations-nightly-sync.ts` pulls from
  ResMed AirView, Philips Care Orchestrator, 3B Medical (React Health), and
  Android Health Connect (`lib/resupply-integrations*`), normalising nightly
  usage/AHI/leak/pressure into `patient_therapy_nights`.
- **CMS 90/30 setup adherence** — RPCs in
  `lib/resupply-db/drizzle/0182_therapy_setup_adherence_rpcs.sql`; surfaced at
  `/admin/therapy-compliance/*`. Buckets new patients **qualified / on_track /
  at_risk** and already computes `days_remaining` and `nights_needed`.
- **Ongoing fleet compliance** — RPCs in
  `0179_therapy_fleet_analytics_rpcs.sql`
  (`therapy_fleet_overview`, `therapy_fleet_worklist`); surfaced at
  `/admin/therapy-fleet/*` with a **multi-factor outreach worklist**
  (compliance risk, no-recent-data, high AHI, high leak, usage decline).
- **Prediction & snapshots** —
  `artifacts/resupply-api/src/lib/clinical/adherence-predictor.ts`,
  `therapy-fleet-daily-snapshot.ts` (trend substrate),
  `onboarding-checkins.ts` (day 3/7/30/60/90 + a daily at-risk compliance scan
  that opens CSR alerts).

### 2.3 Keep in touch (nurture)

- **Reminders** — hourly `reminders.ts` scan + `reminder-escalation.ts`;
  shared send helpers in `lib/resupply-reminders` (used by both routes and
  jobs); templates in `lib/resupply-templates`.
- **Smart triggers** — `smart-trigger-evaluator.ts` / `smart-trigger-send.ts`
  (therapy-night patterns → reorder nudges).
- **Clinical outreach** — `clinical-outreach-batch.ts` +
  `lib/clinical/clinical-outreach.ts`, logged to `clinical_outreach_log` with a
  14-day per-patient cooldown.
- **Conversational AI** — voice agent (OpenAI Realtime + optional ElevenLabs
  TTS / Deepgram STT, with a Claude post-call summary),
  storefront chatbot, and an authenticated **sleep coach**
  (`lib/clinical/sleep-coach.ts`).
- **Consent** — `communication_preferences` on `shop_customers`
  (email/SMS marketing opt-in, transactional SMS, DND window), enforced by
  `artifacts/resupply-api/src/lib/comm-prefs.ts`.

---

## 3. Lever 1 — Activate dormant features

This is the **highest-ROI, lowest-effort** lever: real capability that's already
written, tested, and wired — just switched off. There are two gating layers.

> **Before enabling anything that contacts patients:** confirm marketing
> opt-in / transactional consent (`communication_preferences`) and respect
> the existing frequency caps. The system fails safe (these are off by
> design), so treat each as a deliberate go-live, ideally staged.

### Table A — Runtime flags seeded OFF

Toggle from the **admin Control Center** (`/admin/control-center`, backed by
`/admin/feature-flags` + `resupply.feature_flags`). Takes effect within ~5 seconds — **no deploy**.

| Flag                                  | Mig  | Turning it ON…                                                                                                                                 | Goal                 |
| ------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `therapy_fleet.auto_outreach`         | 0184 | …lets the nightly at-risk scan send **consented** patients a gentle adherence SMS (today the scan only feeds the staff alert queue).           | compliance + nurture |
| `reminder_escalation.dispatcher`      | 0173 | …escalates **unanswered** resupply reminders across channels (SMS → email → CSR alert) instead of a single touch.                              | sales + nurture      |
| `alerts.auto_dispatch`                | 0181 | …auto-sends event-triggered outreach (e.g. payment-failed recovery, low-usage check-in) that today waits for manual review.                    | sales + compliance   |
| `storefront.auto_reminder_enrollment` | 0174 | …auto-enrols new storefront buyers into resupply reminders, closing the loop from first purchase to recurring revenue.                         | sales                |
| `resupply.entitlement_enforcement`    | 0172 | …adds an order-time **too-soon / over-quantity** guard. _Correctness, not growth_ — it can **block** improper orders to prevent denied claims. | correctness          |
| `resupply.eligibility_enforcement`    | 0185 | …adds an order-time **coverage** guard using the cached 270/271. Also _correctness_ — routes questionable orders to a work queue (fail-open).  | correctness          |

> The two `*_enforcement` guards **reduce improper/denied claims** rather than
> grow sales — enable them deliberately and watch the `resupply_*_blocked` CSR
> alert volume. Everything else in Table A is upside for the three goals.

Most other Control-Center flags are **already ON** (`sms.reminders`,
`email.reminders`, `smart_triggers.dispatcher`,
`patient_onboarding.dispatcher`, `bulk_campaigns.send`,
`cart_abandonment.dispatcher` _flag_, `storefront.checkout`, `voice.agent`,
`storefront.chatbot`, …). The dormancy is specifically the rows above.

### Table B — Boot env-var gates OFF

These need an environment variable set on the service (Railway) **and a
redeploy**.

| Env gate                                                                               | Job                                                        | What it does                                                                                                                                | Goal                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED=1`                                             | `cart-abandonment-scan`                                    | Hourly **auto**-nudge of abandoned carts. Without it, abandoned carts are only nudged when a human clicks "send due" in admin.              | sales                |
| `RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED=1`                                            | `fitter-supply-campaign` + `fitter-conversion-attribution` | 6-touch post-fitting supply nurture with conversion attribution. (Its Control-Center flag is already ON; this env gate is the second lock.) | sales                |
| `CLINICAL_OUTREACH_CRON="<5-field cron>"`                                              | `clinical-outreach-batch`                                  | Proactive non-adherence clinical outreach on a schedule you choose.                                                                         | compliance + nurture |
| `ELIGIBILITY_REVERIFY_CRON="<5-field cron>"`                                           | `eligibility-reverify-batch`                               | Batch eligibility re-verification (emits outbound 270s) so coverage lapses surface before they cause denials.                               | compliance + billing |
| `RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED=1` **and** `RESUPPLY_ADMIN_ALERTS_EMAIL=<inbox>` | `failed-order-emails-digest`                               | Daily PHI-safe digest of orders whose confirmation email **failed** — directly recovers orders that would otherwise be lost.                | sales + ops          |
| `RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED=1`                                           | `prescription-request-auto-draft`                          | Pre-drafts Rx-renewal packets for prescriptions expiring within 30 days (CSR still reviews/sends — it does **not** auto-fax).               | compliance + billing |

**Recommended go-live order** (pure-upside first, patient-contact-heavy later):

1. `RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED` (+ alerts email) — internal only, recovers lost orders.
2. `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED` — patient email, already consent-gated.
3. `reminder_escalation.dispatcher` — better conversion on existing reminders.
4. `RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED` — supply nurture for new fittings.
5. `storefront.auto_reminder_enrollment` — recurring-revenue enrolment.
6. `therapy_fleet.auto_outreach` + `CLINICAL_OUTREACH_CRON` — clinical SMS (most sensitive; confirm consent).
7. `*_enforcement` guards — once you're ready to gate orders on entitlement/eligibility.

---

## 4. Lever 2 — Per-payer compliance rules (genuine gap)

**Problem.** Compliance is hard-coded to the **Medicare** definition. In
`0179_therapy_fleet_analytics_rpcs.sql` and
`0182_therapy_setup_adherence_rpcs.sql` the thresholds are literal:

```sql
COUNT(*) FILTER (WHERE n.usage_minutes >= 240)  AS nights_over_4h   -- ≥ 4 hours
COUNT(*) FILTER (WHERE nights_over_4h >= 21)     AS compliant        -- ≥ 21 of 30
```

There is **no** `compliance_rules` / threshold table anywhere. Patients on plans
whose adherence definition differs from Medicare's 21/30 are therefore
**misclassified** — we either chase patients who are actually fine, or miss
patients who are actually failing their plan's standard. That undermines goal #2
("identify non-compliant sooner") for every non-Medicare book of business.

**Recommended approach (described, not built here).** Mirror the proven
`frequency_rules` pattern, which already does payer-aware resolution:

- New table `compliance_rules` with `match_insurance_payer`, `priority`,
  `min_minutes` (default 240), `required_nights` (default 21),
  `window_days` (default 30), plus an `active` flag and `notes` — seeded with a
  Medicare default at low priority so behavior is unchanged until rules are
  added.
- Resolve per patient the same three-tier way as
  `lib/resupply-domain/src/outreach-plan.ts` (per-patient override → payer rule
  → default).
- Thread the resolved thresholds into the RPCs by **parameterizing** the 240 /
  21 / 30 constants. The fleet RPCs already accept `p_window_days`; the
  setup-adherence RPCs would need an analogous parameter.
- Respect `scripts/check-resupply-migration-prefix.sh` for the new migration.

**Effort:** ~1–2 weeks (migration + RPC parameterization + a small admin CRUD
screen mirroring the frequency-rules editor). **Risk:** low if the Medicare
default is seeded first so existing numbers don't move until a rule is added.

---

## 5. Lever 3 — Closed-loop measurement (partial gap)

**What exists.** A good analytics substrate:
`/admin/analytics/{resupply-funnel,resupply-kpis,compliance-cohorts}`,
`/admin/reports/*` (revenue, orders, refunds, QuickBooks exports),
`/admin/shop/subscriptions/metrics`, `/admin/analytics/csr-productivity`, the
daily `metrics-snapshot` → `metric-alerts` → weekly `owner-digest` pipeline, and
`fitter-conversion-attribution` (fitter leads → first order).

**Gap.** Attribution is **siloed to the fitter funnel**. There's no unified view
of **outreach touch → resulting order or compliance-status change** across the
resupply/clinical flows, and **no revenue-by-source** breakdown (storefront vs.
resupply reminder vs. EHR/Parachute inbound). In practice that means we can't
answer "which nudges actually pay for themselves?" or "did turning on
`therapy_fleet.auto_outreach` move compliance?" — which is exactly what you'd
want before/after activating Lever 1.

**Recommendation.** A closed-loop attribution view that joins
conversation/`clinical_outreach_log`/campaign send events to subsequent
`orders` / `shop_orders` and to `patient_therapy_*` compliance transitions,
tagging revenue by source. Surface it through the existing `metrics_daily`
substrate and the `owner-digest` so it lands in the owner's inbox weekly.
**Effort:** larger (a couple of weeks) — primarily query/rollup design, no new
ingestion. **Do this alongside Lever 1** so activations can be measured.

---

## 6. Lever 4 — Compliance deadline outreach (partial gap)

**What exists.** The setup-adherence RPCs already compute the **prospective
math** — `days_remaining`, `nights_needed`, `best30dayCount`, and the
qualified/on_track/at_risk bucket — but it's surfaced as a **pull** dashboard +
CSV at `/admin/therapy-compliance/*`. `onboarding-checkins.ts` opens CSR alerts
for at-risk patients, and the dormant `therapy_fleet.auto_outreach` can send a
generic adherence SMS.

**Gap.** Nothing turns the 90-day countdown into **deadline-aware, escalating
push**. A patient who needs "6 more compliant nights in the next 11 days or the
rental claim is lost" gets, at most, a generic nudge — not an escalating
sequence that intensifies as day 90 approaches.

**Recommendation.** A prospective deadline-outreach job (either new, or an
extension of `therapy-fleet-alerts-scan.ts`) keyed off the existing
setup-adherence math, with escalation tiers (early encouragement → specific
"X nights in Y days" → final-week urgency + offer to call), gated by the same
consent + cooldown rules as existing outreach, and ideally voiced by the
existing voice agent for the final tier. **Effort:** ~1–2 weeks; depends on
nothing new since the math already exists.

---

## 7. Prioritized roadmap (impact × effort)

| #   | Item                                                                  | Lever | Effort | Risk | Notes                                                     |
| --- | --------------------------------------------------------------------- | ----- | ------ | ---- | --------------------------------------------------------- |
| 1   | Enable `RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED` (+ alerts email)        | 1     | Config | None | Internal only; recovers lost orders immediately.          |
| 2   | Enable cart-abandonment auto-cron                                     | 1     | Config | Low  | Consent-gated patient email.                              |
| 3   | Enable `reminder_escalation.dispatcher`                               | 1     | Config | Low  | More conversions from existing reminders.                 |
| 4   | Enable fitter supply campaign + `storefront.auto_reminder_enrollment` | 1     | Config | Low  | Recurring-revenue enrolment.                              |
| 5   | Enable `therapy_fleet.auto_outreach` + `CLINICAL_OUTREACH_CRON`       | 1     | Config | Med  | Clinical SMS — confirm consent; stage carefully.          |
| 6   | **Per-payer compliance rules**                                        | 2     | 1–2 wk | Low  | Seed Medicare default so nothing moves until rules added. |
| 7   | **Deadline-aware escalating outreach**                                | 4     | 1–2 wk | Med  | Reuses existing setup-adherence math.                     |
| 8   | **Closed-loop attribution + revenue-by-source**                       | 3     | ~2 wk  | Low  | Measures the impact of items 1–7.                         |

Items **1–5 are days of config** (plus consent sign-off), not engineering.
Items 6–8 are the genuine builds. Doing **8 early-ish** is worth it: it's how
you'll prove the activations in 1–5 are working.

---

## 8. Risks & guardrails

Any follow-up build must respect the repo's hard rules (see `CLAUDE.md`), which
are correctness invariants, not style:

- **No PHI in logs** — no image bytes, no order request bodies, no patient
  contact details. Outreach jobs log counts/status only.
- **Supabase-only data path** — route/worker reads/writes go through
  `getSupabaseServiceRoleClient()`; no new direct `pg` outside
  `lib/resupply-db`.
- **No new column encryption**, **no password pepper**, **no HIPAA/`audit_log`
  compliance machinery** (the audit package is a no-op stub).
- **One From address** (`info@pennpaps.com`) via the shared SendGrid client.
- **Admin theme stays scoped** to `.admin-root`.
- **Service-boot stays decoupled** — never re-couple HTTP serving to the worker
  or point the health check at `/readyz`.

Operational guardrails specific to this roadmap:

- **Consent first.** Every patient-contact activation honors
  `communication_preferences` (marketing opt-in, transactional, DND) and the
  per-patient frequency caps already in `clinical_outreach_log` and the
  reminder de-dup logic.
- **Stage activations** and measure (Lever 3) — turn one lever on, watch the
  metrics and CSR alert volume, then proceed.

---

## 9. Appendix — file & table reference index

**Worker jobs** (`artifacts/resupply-api/src/worker/jobs/`): `reminders.ts`,
`reminder-escalation.ts`, `smart-trigger-evaluator.ts`, `smart-trigger-send.ts`,
`clinical-outreach-batch.ts`, `cart-abandonment-scan.ts`,
`lapsed-customer-winback.ts`, `deductible-reset-push.ts`,
`fitter-supply-campaign.ts`, `fitter-conversion-attribution.ts`,
`shop-order-delivery-followup.ts`, `low-stock-alerts.ts`,
`lifecycle-touchpoints.ts`, `quarterly-therapy-summary.ts`,
`onboarding-checkins.ts`, `therapy-integrations-nightly-sync.ts`,
`therapy-fleet-daily-snapshot.ts`, `therapy-fleet-alerts-scan.ts`,
`coaching-plan-progress.ts`, `eligibility-reverify-batch.ts`,
`prescription-request-auto-draft.ts`, `failed-order-emails-digest.ts`,
`metrics-snapshot.ts`, `metric-alerts-evaluator.ts`, `metric-alerts-notify.ts`,
`owner-digest.ts`. Registration + scheduling: `worker/index.ts`.

**Feature flags:** `artifacts/resupply-api/src/lib/feature-flags.ts`
(`FEATURE_FLAG_KEYS`), seed `lib/resupply-db/drizzle/0149_feature_flags.sql`,
plus per-flag seeds 0151 / 0172 / 0173 / 0174 / 0181 / 0184 / 0185.
Admin route: `artifacts/resupply-api/src/routes/admin/feature-flags.ts`.

**Compliance RPCs / tables:** `0179_therapy_fleet_analytics_rpcs.sql`,
`0182_therapy_setup_adherence_rpcs.sql`, `0184_therapy_fleet_alerts.sql`;
tables `patient_therapy_nights`, `patient_therapy_links`,
`patient_integration_snapshots`, `therapy_fleet_daily_metrics`,
`patient_worklist_actions`, `patient_therapy_milestones`.

**Cadence engine (per-payer pattern to mirror):** `frequency_rules` table
(`0002_*.sql`, seed `0070_seed_medicare_cadences.sql`); resolver
`lib/resupply-domain/src/outreach-plan.ts`.

**Storefront / orders:** `artifacts/resupply-api/src/routes/shop/*`,
`lib/stripe/*`, tables `shop_orders`, `shop_order_items`, `shop_customers`,
`shop_subscriptions`, `shop_abandoned_carts`; clinical-side `orders`,
`episodes`, `fulfillments`, `prescriptions`.

**Consent:** `communication_preferences` (on `shop_customers`, mig
`0018_shop_customers_comm_prefs.sql`), enforced in
`artifacts/resupply-api/src/lib/comm-prefs.ts`; outreach audit
`clinical_outreach_log` (mig `0204`).

---

_Prepared as a review/roadmap only. No application behavior was changed by this
document._
