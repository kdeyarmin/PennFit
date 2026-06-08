# PennFit Feature & Function Review + Gap Research — 2026-06-07

**Audience:** Penn Home Medical Supply ownership + engineering.
**Goal:** A thorough, code-verified review of every product surface, then research
on what is genuinely missing to make PennFit _the best_ platform for the four
internal personas: **DME owners, customer-service reps (CSRs), billers, and
respiratory therapists (RTs).**
**Method:** Full route/page/job inventory + four parallel code-depth audits (one
per persona) that tagged each capability **REAL / PARTIAL / STUB / MISSING**
against the actual implementation (not route names), cross-checked against the
prior internal reviews in `docs/` and June-2026 DME industry research.

> **How this differs from the existing docs.** The 2026-06-06, 2026-06-05, and
> 2026-05-19 reviews already mapped the dormant-flag activations and the
> Medicare-only compliance gap. This document does **not** re-litigate those. It
> is a fresh, code-grounded pass focused on the _genuinely unbuilt or stubbed_
> capabilities that remain after that wave of work — the things a real DME
> owner/CSR/biller/RT would still hit — plus the 2026 industry features that
> would push PennFit from "complete" to "best in class."

---

## 1. Verdict

PennFit is, by a wide margin, the most complete DME/CPAP-resupply codebase I've
reviewed: **~115 admin pages, ~150 API routes, ~50 background jobs**, a full X12
5010 billing suite, four therapy-cloud integrations, an AI voice agent, and a
D2C storefront. The four audits confirm most of this is **genuinely
implemented**, not scaffolding.

The honest maturity read:

| Surface                  | Verified maturity                | One-line                                                                                                     |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Resupply outreach engine | ~95% REAL                        | Cadence, reminders, escalation, smart triggers, win-back — all real; some dormant by flag.                   |
| Billing / RCM            | ~70% REAL, 20% PARTIAL, 10% STUB | Strong EDI backbone (837P/835/270/PAS); gaps in **outbound fax, 276/277, form PDFs**.                        |
| Clinical / RT            | ~80% REAL                        | Real ingestion, CMS 90/30, encounters, smart triggers; gaps in **outcome measurement & cohort tools**.       |
| CSR / conversations      | ~85% REAL                        | Omnichannel inbox, routing, voice AI, macros real; gaps in **real-time alerting & inline clinical context**. |
| Owner / ops / analytics  | ~75% REAL                        | Excellent financial analytics; **single-tenant**, no PO/payroll/GL-posting.                                  |

**The remaining work is no longer "build the basics."** It is three things:

1. **Close the last-mile billing gaps** that force billers out of the system (fax, claim status, form generation).
2. **Add the operational scaffolding a growing DME needs** (multi-location, purchasing, GL posting).
3. **Ship the 2026 differentiators** (patient financing, HSAT funnel, ML adherence, real-time CSR alerting) that move PennFit ahead of Brightree/WellSky/NikoHealth rather than level with them.

---

## 2. What's genuinely strong (lead with these)

Verified REAL in code during this audit — these are competitive assets, not to be touched except to extend:

- **AI billing pipeline** — pre-submit claim scrubber + post-denial analyzer with a _safe-listed patch whitelist_ and a conservative `can_auto_resubmit` gate (`lib/billing/ai-claim-scrubber.ts`, `ai-denial-analyzer.ts`). No surveyed competitor publishes this with the same rigor.
- **Real X12 backbone** — 837P generation + SFTP submission, 835 ERA parse + auto-post, 270 build/upload, Da Vinci PAS FHIR submission (`lib/billing/office-ally-batch.ts`, `era-reconciler.ts`, `eligibility-verifier.ts`, `routes/admin/davinci-pas-submit.ts`).
- **Four-vendor therapy ingestion** — ResMed AirView, Philips Care Orchestrator, 3B/React Health, Health Connect, with live OAuth and a no-fabricated-data posture (503 when unconfigured).
- **CMS 90/30 setup-adherence math** computed for real, with `days_remaining`/`nights_needed` and a qualified/on_track/at_risk worklist.
- **Omnichannel CSR inbox** — SMS + email + voice + fax in one thread store, skill-based routing, AI triage/draft-reply, live staffing, click-to-dial with TCPA window guard.
- **Real-time AI voice agent** — OpenAI Realtime ↔ Twilio bridge, inbound _and_ outbound, optional ElevenLabs TTS / Deepgram audit transcript, Claude post-call summary.
- **Financial analytics depth** — margin (with honest uncosted-revenue disclosure), payer profitability net-of-COGS, LTV/CAC by channel, revenue-by-source, collections forecast, internal benchmark percentiles.
- **Privacy-first on-device mask fitter** — MediaPipe facial measurement; images never transmitted; the fit-outcome feedback loop is wired into the recommendation engine.

---

## 3. The genuinely-missing list, by persona

Each item is tagged with verified status and an effort estimate. Items already
covered by the dormant-flag activations (June-05 doc) or shipped in the June-06
PR are **excluded**.

### 3.1 Billers / revenue cycle

| #      | Gap                                                                      | Status                                          | Why it matters                                                                                                                                                                                                                                                                                                                                                                                               | Effort | Anchor                                                                                      |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| B1     | **Outbound fax** for appeal letters & non-FHIR prior-auth / DWO requests | STUB (delivery_method is metadata only)         | The single biggest hole. ~40% of payers still require fax for PA & appeals; today the biller renders a perfect PDF and then must leave the system to send it.                                                                                                                                                                                                                                                | M      | `routes/admin/claim-appeals.ts`, `payer-profiles.prior_auth_submission_method`              |
| ~~B2~~ | ~~271 inbound auto-processing~~                                          | ✅ **already shipped** (correction)             | Verified in follow-up: `office-ally-inbound-poll.ts` already has `case "271": dispatch271(...)` — it parses the 271, matches it to the `eligibility_checks` row by ISA control number, sets `status='parsed'` with the parsed coverage fields, and fires an `eligibility.completed` webhook. The stale comment in `eligibility-verifier.ts` predates the poller wiring. **Drop from scope.**                 | —      | `office-ally-inbound-poll.ts` (`dispatch271`)                                               |
| B3     | **276/277 claim-status inquiry**                                         | MISSING                                         | Billers can't proactively ask "where's my claim?" on stale submissions — they wait for the ERA. Every major competitor has this.                                                                                                                                                                                                                                                                             | M      | (new) alongside `billing-timely-filing.ts`                                                  |
| B4     | **CMN / DWO / SWO PDF generation**                                       | STUB (tracking rows exist; no form-fill/render) | Oxygen CMN-484, 5-element DWO/SWO are tracked for expiry but generated by hand outside the app. Blocks oxygen/RAD line expansion.                                                                                                                                                                                                                                                                            | M      | `routes/admin/dwo-documents.ts`                                                             |
| B5     | **Billing action-queue roll-up**                                         | ✅ **implemented (this PR)**                    | The per-claim denials worklist + secondary-eligible list already existed; what was missing was the morning-triage roll-up. `GET /admin/billing/action-queue` groups actionable denials by recommended action (reusing `rankDenialWorklist`) and adds secondary-eligible count + billable balance. Read-only — auto-_generating_ appeals/secondaries stays a deliberate human click (intentional, not a gap). | done   | `routes/admin/billing-action-queue.ts`, `denials-worklist.ts` (`loadDenialInputs`)          |
| ~~B6~~ | ~~Unbilled / unpaid-claim aging worklist~~                               | ✅ **already shipped** (correction)             | A/R aging already exists at `GET /admin/billing/aging-report` (every non-terminal claim bucketed by age) + the `admin-billing-aging.tsx` page. The original audit mis-tagged this as a STUB; verified present during implementation. **Drop from scope.**                                                                                                                                                    | —      | `routes/admin/*aging*`, `pages/admin/admin-billing-aging.tsx`                               |
| B7     | **Patient financing / payment plans / BNPL**                             | MISSING                                         | 2026 trend: installment plans lift upfront collections ~25% and cut bad debt as patient responsibility rises. No plan engine today (Stripe one-shot + manual statements only).                                                                                                                                                                                                                               | M      | (new) on `patient_payment` + Stripe                                                         |
| B8     | **Modifier-rule resolution for manual/corrected claims**                 | ✅ **implemented (this PR)**                    | Extracted the payer modifier-rule evaluation into a shared pure module (`lib/billing/modifier-rules.ts`, now the single source of truth for both the fulfillment claim builder and this) and exposed `GET /admin/payer-modifier-rules/resolve?payerProfileId=&hcpcs=&rentalMonth=…` so the manual-claim line editor can pre-fill the same KX/KH/KI rotation instead of the CSR guessing.                     | done   | `lib/billing/modifier-rules.ts`, `routes/admin/payer-modifier-rules.ts`, `claim-builder.ts` |

### 3.2 Respiratory therapists / clinical

| #   | Gap                                                 | Status                                                   | Why it matters                                                                                                                                                                                                                                                                                                                                                             | Effort         | Anchor                                                        |
| --- | --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| R1  | **Intervention outcome measurement (therapy lift)** | ✅ **implemented (this PR)**                             | RTs no longer _guess_ improved/no-change. `GET /admin/interventions/:id/outcome-measurement` compares `patient_therapy_nights` in the window before vs. after the intervention date (avg usage, Medicare compliance rate, AHI, leak) and derives improved/no_change/worsened from the usage delta. Read-only, PHI-safe (counts+signal logged only), pure core unit-tested. | done           | `routes/admin/interventions.ts` (`computeOutcomeMeasurement`) |
| R2  | **RT cohort / bulk-campaign tooling**               | MISSING                                                  | No "assign all high-leak ResMed patients to a mask-refit program." Outreach is per-patient or a fixed daily cron; RTs can't segment & act on a population.                                                                                                                                                                                                                 | M              | `lib/clinical/clinical-outreach.ts`                           |
| R3  | **Unified clinical comms timeline**                 | MISSING (encounters & SMS/email live in separate tables) | An RT can't see "texted Tue, patient replied Wed" inside the clinical record. Fragmented context slows every intervention.                                                                                                                                                                                                                                                 | M              | `clinical-encounters.ts` + `conversations/*`                  |
| R4  | **HSAT (home sleep test) in-funnel order**          | MISSING                                                  | Closes the funnel from "I might have apnea" → prescribed CPAP in ~72h (Itamar/NightOwl model). Sleep-study capture is external-lab-only today.                                                                                                                                                                                                                             | M + partner    | `routes/patients/sleep-studies.ts`                            |
| R5  | **Telehealth Rx-renewal partnership**               | MISSING                                                  | Captures the Rx-renewal revenue that today bounces to a PCP who often won't sign. Renewal workflow exists; the signing network does not.                                                                                                                                                                                                                                   | S + partner    | `prescription-renewals.ts`                                    |
| R6  | **Sleep-coach grounded in real therapy data**       | ✅ **already shipped** (correction)                      | Verified during follow-up: `lib/clinical/sleep-coach.ts` `assembleContext()` already pulls the patient's last-7-day `patient_therapy_nights` (avg usage, AHI, max leak, compliant-night count) into the prompt, PHI-safe (initials + DOB year + aggregates). The original audit understated this. **Drop from scope.**                                                     | —              | `lib/clinical/sleep-coach.ts` (`assembleContext`)             |
| R7  | **ML adherence model**                              | PARTIAL (heuristic only)                                 | The `heuristic-1.0` scorer is fine for early triage but won't generalize; EnsoData-class models hit AUC ~0.97. Gated on accumulating ~1k+ therapy records first.                                                                                                                                                                                                           | L (data-gated) | `lib/clinical/adherence-predictor.ts`                         |
| R8  | **Live ResMed/Philips data (BAA unblock)**          | BLOCKED (contract, not code)                             | Adapters are production-quality but gated on executed partner BAAs/OAuth. Until then the whole adherence pillar runs on 3B/patient-push data. Track as a _business_ action.                                                                                                                                                                                                | — (contract)   | `lib/resupply-integrations-airview`, `-care-orchestrator`     |

### 3.3 Customer-service reps

| #   | Gap                                           | Status                                       | Why it matters                                                                                                                                                                                                                                                                                                                                                              | Effort | Anchor                                                   |
| --- | --------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| C1  | **Real-time alerting / paging**               | MISSING (CSRs poll the inbox)                | No push/desktop alert when a high-priority conversation lands or an SLA is about to breach. Breaches are _visible_ but not _announced_.                                                                                                                                                                                                                                     | S–M    | `conversations/list.ts`, `inbox-counts.ts`               |
| C2  | **SLA auto-escalation workflow**              | ✅ **implemented (this PR)**                 | New `sla-escalation-sweep` worker flags conversations past their SLA deadline as `escalated_at`/`sla_breached`, which drives the existing inbox "escalated" view (`.not("escalated_at","is",null)`) — no schema/UI change. Internal visibility flag only (no patient contact); opt-in via `RESUPPLY_SLA_ESCALATION_CRON`. Pure `planSlaEscalations` (severity) unit-tested. | done   | `worker/jobs/sla-escalation-sweep.ts`, `worker/index.ts` |
| C3  | **Inline therapy/adherence context for CSRs** | ✅ **implemented (this PR)**                 | `GET /admin/patients/:id/therapy-snapshot` returns a compact recent-adherence snapshot (avg usage hrs, compliance %, AHI, leak, data-staleness) gated on `patients.read` (CSRs hold it) so a CSR sees "is this patient using their machine?" without leaving the thread. Pure `buildTherapySnapshot` unit-tested. Frontend panel wiring is the only follow-up.              | done   | `routes/admin/patient-therapy-snapshot.ts`               |
| C4  | **Sentiment / urgency inference on inbound**  | MISSING                                      | All messages treated equally. A "this patient sounds distressed — escalate?" hint (the voice agent already does this post-call) would help triage.                                                                                                                                                                                                                          | S      | `routes/sms/inbound.ts`                                  |
| C5  | **Call-recording archive for QA/training**    | MISSING/unclear (post-call summaries only)   | Voice calls produce a summary + transcript but no CSR-facing audio archive for coaching/dispute resolution.                                                                                                                                                                                                                                                                 | S–M    | `lib/voice/ws-handler.ts`                                |
| C6  | **In-composer knowledge base / FAQ search**   | MISSING (macros are the only canned content) | CSRs can't search a KB while replying; macros are static snippets, not searchable answers.                                                                                                                                                                                                                                                                                  | S      | `csr-macros.ts`                                          |
| C7  | **Rule-based snooze**                         | ✅ **implemented (this PR)**                 | The snooze endpoint now accepts a `snoozeSpec` ("1d", "4h", "next_business_day", "next_week") resolved server-side (pure `resolveSnoozeUntil`, max-horizon clamped) in addition to the absolute `snoozedUntil`. (Hand-off/consult mode remains a separate, larger follow-up.)                                                                                               | done   | `lib/snooze-spec.ts`, `conversation-triage.ts`           |

### 3.4 Owners / operations

| #   | Gap                                             | Status                                                                         | Why it matters                                                                                                                                                                                                        | Effort            | Anchor                                                  |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------- |
| O1  | **Multi-location / multi-tenant**               | STUB (singleton `dme_organization`)                                            | The hard ceiling on growth. A second branch or an acquired location hits the singleton constraint immediately — no per-location inventory, revenue, or staffing. Schema is forward-compatible (mig 0132) but unbuilt. | L                 | `routes/admin/dme-organization.ts`, mig `0132`          |
| O2  | **Purchasing / PO + supplier management**       | STUB (low-stock emails only)                                                   | No PO workflow, supplier master, or wholesaler integration (Medline/McKesson). Replenishment is a manual reconciliation.                                                                                              | M                 | `inventory-turnover.ts`, `low-stock-alerts.ts`          |
| O3  | **GL auto-posting (QuickBooks is export-only)** | PARTIAL                                                                        | IIF/QBO exports exist but require manual account mapping on import. No real-time GL posting or account-mapping UI.                                                                                                    | M                 | `routes/admin/reports.ts`                               |
| O4  | **Payroll / timekeeping**                       | STUB (shift tracking shows who's on duty only)                                 | No time-card approval, wage accrual, or ADP/Gusto integration. Likely intentionally out-of-scope, but worth an explicit decision.                                                                                     | M (or integrate)  | `csr-shifts.ts`                                         |
| O5  | **DME-org onboarding checklist**                | STUB                                                                           | There's a _patient_ setup checklist but no guided "stand up this DME" flow (vendor config → team invite → billing config → preflight). Raises switching cost.                                                         | S                 | `setup-checklist.ts` (patient-only), `account-setup.ts` |
| O6  | **External compliance/audit export**            | By design absent (audit machinery retired mig 0156; audit pkg is a no-op stub) | Compliance is handled out-of-band by ownership — _correct per `CLAUDE.md`_. Flagged only so an owner facing the **Jan-2026 annual DMEPOS resurvey** knows survey-readiness reporting is deliberately not in-app.      | — (policy)        | `CLAUDE.md` hard rules                                  |
| O7  | **Native owner/patient mobile app**             | DEFERRED                                                                       | SPA + Apple Wallet + web push cover today's need; a Capacitor wrap is the cheap path if engagement justifies.                                                                                                         | M                 | —                                                       |
| O8  | **National benchmark analytics**                | Phase-1 only (internal percentiles)                                            | Owners want "are we above/below industry on KX denial rate?" Internal cohort percentiles exist; external benchmark licensing (VGM) is a later bet.                                                                    | S (P1 done) / OOB | `billing-benchmarks.ts`                                 |

---

## 4. Cross-cutting: performance & data hygiene at scale

(From the June-06 review, re-confirmed — matters as patient/claim volume grows.)

- **~68 `count: 'exact'` calls across 34 files** on hot dashboard tables — switch to `'estimated'` where an approximate total is acceptable (badge counts).
- **Missing billing indexes** on hot queries (e.g. `insurance_claims(decision_at)`, `(status, submitted_at)`).
- **In-memory aggregation with `.limit(20000)` truncation caps** in `ltv-cac.ts`, `billing-director.ts`, `analytics.ts`, `mask-fit-worklist.ts` — push aggregation into SQL RPCs so totals stay correct past the cap.

---

## 5. Recommended sequencing

A coherent, ROI-ordered plan that spans all four personas. Items 1–2 are config
the prior docs already detailed (activate dormant jobs) and are assumed done/in
progress; this list is the _new build_ work.

**Wave 1 — close the billing last mile (highest direct $ impact)**

1. **B1 Outbound fax** (appeals + non-FHIR PA/DWO). Unblocks ~40% of payers; stops billers leaving the system.
2. **B2 271 auto-processing** + **B5 auto-appeal/secondary worklist**. Closes the eligibility & denial loops the AI already analyzes.
3. **B6 unbilled/unpaid aging worklist** + **B8 modifier auto-apply on manual claims**. Pure RCM hygiene, small effort.

**Wave 2 — operational scaffolding + CSR/RT quick wins** 4. **C1/C2 real-time alerting + SLA auto-escalation** and **C3 inline therapy context**. Cuts CSR handle time; mostly UI + a notification channel. 5. **R1 intervention outcome measurement** + **R6 therapy-grounded sleep coach**. Turns RT activity into measurable outcomes; data already exists. 6. **B4 CMN/DWO/SWO PDF generation** (reuse the HCFA pdfkit path). Enables oxygen/RAD expansion. 7. **O5 DME-org onboarding checklist** + **O3 GL account-mapping UI**.

**Wave 3 — 2026 differentiators & growth ceiling** 8. **B7 patient financing / payment plans (BNPL)** — collections lift as patient responsibility rises. 9. **R4 HSAT funnel** + **R5 telehealth Rx renewal** (partner-gated) — vertical-integrate acquisition. 10. **O2 purchasing/PO** + **O1 multi-location** — the two biggest "we outgrew it" risks. 11. **R7 ML adherence model** (once ~1k+ therapy records accumulate) and **C5 call-recording archive**.

**Always-on**: §4 performance items, and tracking **R8 (ResMed/Philips BAA)** as a business/contract action since it gates the entire RT data pillar.

---

## 6. One-paragraph answer for the owner

PennFit already does the hard parts most DME platforms never finish: a real AI
billing pipeline, real X12 claims/ERA/eligibility, four therapy-cloud feeds, an
omnichannel inbox, and a live AI voice agent. To be _the best_, the priorities
are (1) **finish the billing last mile** — outbound fax, 271 auto-processing,
276/277 status, and form-PDF generation — so a biller never has to leave the
app; (2) **add the operations scaffolding a growing DME needs** — multi-location,
purchasing/PO, and GL posting; and (3) **ship the 2026 patient-experience
differentiators** — financing/BNPL, an HSAT acquisition funnel, a
therapy-grounded sleep coach, and real-time CSR alerting. None of these are
research projects; they're well-scoped builds on top of an already-strong base.

---

## Sources

### Code (verified this pass)

- Route inventory: `artifacts/resupply-api/src/routes/**`, page inventory `artifacts/cpap-fitter/src/pages/admin/**`, jobs `artifacts/resupply-api/src/worker/jobs/**`.
- Billing: `lib/billing/{office-ally-batch,era-reconciler,eligibility-verifier,ai-claim-scrubber,ai-denial-analyzer,capped-rental-advancer}.ts`, `routes/admin/{claim-appeals,dwo-documents,secondary-claims,davinci-pas-submit,payer-*}.ts`.
- Clinical: `lib/clinical/{adherence-predictor,clinical-outreach,sleep-coach}.ts`, `routes/admin/{interventions,clinical-encounters,therapy-fleet,therapy-compliance,mask-fit-worklist}.ts`.
- CSR: `routes/{conversations,sms,voice,email,fax}/**`, `lib/voice/ws-handler.ts`, `routes/admin/{conversation-*,csr-*,staffing-live,work-items}.ts`.
- Owner: `routes/admin/{analytics-*,payer-profitability,ltv-cac,inventory-*,reports,business-targets,metric-*,team,mfa,webhook-*,dme-organization}.ts`, mig `0132`.

### Prior internal reviews (built on, not duplicated)

- `docs/dme-app-improvements-2026-06-06.md`, `docs/growth-compliance-review-2026-06-05.md`, `docs/competitive-gap-analysis-2026-05-19.md`, `docs/feature-roadmap-2026-05-31.md`, `docs/dme-resupply-automation-research-and-recommendations-2026-05-30.md`.

### Industry research (June 2026)

- [DME/HME Software in 2026 — Brightree alternatives & must-haves (Coruzant)](https://coruzant.com/software/dme-and-hme-software-in-2026/)
- [How HME resupply is evolving with AI (HME Business)](https://hme-business.com/how-hme-resupply-is-evolving-with-ai/)
- [Curasev / Seva AI — AI document intake for DME](https://www.curasev.com/solutions/seva-ai-intelligent-document-intake-automation-for-dme-hme-providers)
- [Parachute Health — AI Intake: digitizing fax orders is no longer enough](https://blog.parachutehealth.com/ai-intake-for-dme)
- [NikoHealth — Medicare DME Billing Requirements 2026](https://nikohealth.com/medicare-dme-billing-requirements-in-2026-a-complete-guide/)
- [Cherry — patient payment plans guide](https://withcherry.com/blog/patient-payment-plans)
- [PayZen — AI patient financing](https://payzen.com/)
- [Medical Economics — fixing payment problems in 2026](https://www.medicaleconomics.com/view/how-to-fix-payment-problems-in-your-medical-practice-in-2026)

_Review/research only. No application behavior was changed by this document._
