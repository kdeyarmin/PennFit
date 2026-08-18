# Competitor Analysis: SleepGlad vs. CareMetric Breathe (the fitter)

_Date: 2026-08-18 · Source: <https://www.sleepglad.com> (home,
`/supplier-providers`, `/formulary-list`, `/physicians-referral-network`,
`/truckers`, `/contact`) plus trade coverage, vs. this codebase at commit
`655e3da`._

> **One-line takeaway:** SleepGlad is a **feature**, not a platform — an AI mask
> fitter plus a physician referral network. Our fitter already matches or beats
> it on nearly every published axis, and on several it has machinery SleepGlad
> does not appear to have at all. What SleepGlad has that we don't is a **sales
> story backed by numbers**, two workflow conveniences, and a visual. Three of
> the four real gaps are about **proving and distributing** fitting quality we
> already built — not about building quality we lack.

This is the **fitter-level** teardown that
[`competitor-analysis-total-sleep-services-2026-06-14.md`](./competitor-analysis-total-sleep-services-2026-06-14.md)
deferred. That doc analysed VGM Total Sleep Services at the **bundle** level and
noted only that "the AI mask-fitting tech comes from SleepGlad." Two things
changed since: SleepGlad deserves its own head-to-head because it competes
directly with our core differentiator, and a great deal shipped in between —
migrations **0481–0487** (Mask Intelligence Catalog, formulary, fit sessions,
safety screening, provider referral portal), merged in the two commits before
this analysis.

---

## 1. What SleepGlad actually is

A secure, cloud-based **3D PAP/NIV mask-fitting platform**. A provider texts the
patient a link; the patient answers a short questionnaire (sleep patterns,
sleeping position, and similar) and takes a selfie; the service analyses the
facial geometry server-side and returns a **manufacturer-agnostic** mask model
and size. No app download, no hardware.

**Ownership chain** — easy to garble, so state it correctly:

1. Founded **early 2020** by **Akhil Raghuram, MD**, a board-certified sleep
   physician.
2. Acquired by **Baxter Technologies / Baxter Management** (president David
   Baxter) — which also owns **S3 Resupply**. This is where SleepGlad's
   intake-to-resupply story comes from. Note this is **not** Baxter
   International, the medtech company.
3. Acquired by **VGM Group in January 2025** (David Baxter stepped away), where
   it became the AI-fitting layer inside VGM Total Sleep Services.

**Privacy posture.** Per trade coverage, "SleepGlad throws away the patient image
and reconstructs it with multiple measurements using its patented technology" —
i.e. the photo **is** uploaded to their cloud and then discarded server-side.

### Published feature surface

| Area             | What they advertise                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scan             | Selfie via any phone camera; reportedly ~4,500 facial points; "Scan Now" mode for in-office scans                                                                                   |
| Questionnaire    | Sleep patterns, sleeping position, and comfort/tolerance factors                                                                                                                    |
| Recommendation   | Manufacturer-agnostic mask **model + size**, "in seconds"                                                                                                                           |
| Formulary        | ~60 models across 9 manufacturers; provider sets their own formulary                                                                                                                |
| Safety           | "Automated magnetic clip contraindication documentation"                                                                                                                            |
| Referral network | Physicians review and sign **multiple patients in seconds**, attach scan results to an **electronic prescription**, share documents, and **chat in real time** with other providers |
| Refit program    | "No questions asked" mask replacement; refit form feeds back into the model                                                                                                         |
| Learning         | "Every scan builds on itself"                                                                                                                                                       |
| BI               | Predictive analysis, inventory tooling, and optimising **established patients onto ideal newer products**                                                                           |
| Integration      | S3 Resupply: referral → scan → paperwork → scheduling → virtual visit → claim submission; document processing, video chat, e-signatures, product demos, planned electronic CMNs     |

### On their numbers

SleepGlad markets **97% accuracy**, a **2-minute** send-to-result cycle,
**15+ minutes** of clinician time saved per setup, and (via VGM) refit rates of
**5% or less against a 22–25% industry average**.

Treat these as **unvalidated vendor claims**. No peer-reviewed validation of the
platform appears to exist, and their own site is internally inconsistent —
`/supplier-providers` says **97%** while `/truckers` says **">90%"**. That is not
a reason to be complacent: it is a reason to instrument our own numbers rather
than invent counter-claims. See §5.

---

## 2. Head to head

| Capability                               | SleepGlad                                                      | CareMetric Breathe                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Remote scan**                          | Selfie **uploaded** to their cloud, then discarded             | ✅ **Structurally better** — capture runs on-device via MediaPipe FaceLandmarker (`pages/capture.tsx`, `pages/measure.tsx`); images **never leave the browser**. Only scalar measurements are transmitted. Discarding an image after upload and never transmitting it are not the same privacy claim.                                                                                                              |
| **Recommendation engine**                | ML ranking, undisclosed                                        | ✅ **Deeper** — the 6-tier pipeline in `lib/fitting/tiers.ts`: (1) safety and (2) therapy compatibility are **hard filters**, not score penalties, so no commercial boost can ever out-score a contraindication; then facial fit, patient characteristics, formulary, inventory. Tiers 5–6 are bounded so they can only re-order near-ties, and they feed **ranking only** — never the patient-facing confidence.  |
| **Sizing**                               | Model + size                                                   | ✅ Per-size **millimetre bands** in `mask_size_variants` (0481), with cushion and frame resolved independently.                                                                                                                                                                                                                                                                                                    |
| **Provider formulary**                   | Provider sets their formulary                                  | ✅ **Deeper** — `formularies` / `formulary_rules` (0482) scope by contract, payer, location, therapy mode and service line, with an unambiguous specificity ordering. A payer-specific deny deliberately does **not** fire when the payer is unknown — we never deny on an assumption.                                                                                                                             |
| **Magnetic contraindication**            | "Automated documentation"                                      | ✅ **Version-controlled** (0484): the exclusion rule is data, not code, so revising a manufacturer warning is a new version row rather than a deploy, and a report can cite `magnetic_implant@v1` precisely. Screens the **household**, not just the patient. **Flag currently OFF.**                                                                                                                              |
| **Questionnaire**                        | Sleep position, claustrophobia, nasal breathing                | ✅ 11 structured inputs live today (`recommendationEngine.ts`); the ~20-question `fitter.fit_profile_v2` is built. **Flag OFF.**                                                                                                                                                                                                                                                                                   |
| **Clinical record**                      | Not advertised                                                 | ✅ **No visible equivalent** — `fit_sessions` + append-only `fit_session_events` (0483) and a stamped PDF fit report covering scan quality, measurements, fit profile, safety screening, primary recommendation, alternatives, **what was ruled out and why**, clinical review, dispensing and provenance. Rules are stamped at compute time so a report reprinted a year later shows the rules that actually ran. |
| **Confidence**                           | Not advertised                                                 | ✅ `lib/fitting/confidence.ts` — the system is allowed to say "I don't know" and route to human review instead of guessing.                                                                                                                                                                                                                                                                                        |
| **Referral network**                     | E-scripts with scan attached, batch signing, provider↔DME chat | ✅ Migration 0487 (`provider_dme_links`, `referrals`, `referral_documents`, `referral_messages`, `referral_events`), batch signing via `BatchSignPanel` in `pages/provider/provider-queue.tsx`, MFA-gated provider identity.                                                                                                                                                                                       |
| **Refit feedback loop**                  | "Every scan builds on itself"                                  | ✅ `mask_fit_outcomes` → `computeFitAdjustments()` (`lib/storefront/mask-fit-tuning.ts`): neutral until ≥10 samples, clamped to ±0.15 so feedback can re-order near-ties but can never rescue a clinically poor mask.                                                                                                                                                                                              |
| **Compliance / early intervention**      | Referenced                                                     | ✅ **Far deeper** — CMS LCD L33718 engine, smart-trigger dispatcher, ML adherence predictor, clinical outreach, intervention worklist.                                                                                                                                                                                                                                                                             |
| **Video, e-sign, documents, e-CMN**      | Via S3                                                         | ✅ All present natively.                                                                                                                                                                                                                                                                                                                                                                                           |
| **BI / inventory**                       | Predictive analysis                                            | ✅ **Far deeper** — LTV/CAC, margin, payer profitability, inventory turnover, acquisition funnel.                                                                                                                                                                                                                                                                                                                  |
| **In-office "Scan Now"**                 | ✅                                                             | ❌ **GAP** — `routes/admin/fitter-invites.ts` delivers by email or SMS only.                                                                                                                                                                                                                                                                                                                                       |
| **Refit rate as a reported KPI**         | ✅ (their headline)                                            | ❌ **GAP** — outcomes are collected and used for tuning, never surfaced as a rate.                                                                                                                                                                                                                                                                                                                                 |
| **Established-patient upgrade campaign** | ✅                                                             | ❌ **GAP** — every fitter campaign targets _new_ leads.                                                                                                                                                                                                                                                                                                                                                            |
| **Visual mask-on-face preview**          | ✅                                                             | ❌ **GAP** — results are text/photo cards.                                                                                                                                                                                                                                                                                                                                                                         |
| **Scan fidelity**                        | ~4,500 points claimed                                          | 🟡 478 landmarks captured, reduced to 5 scalars. `fitter.multiframe_capture` is built. **Flag OFF.**                                                                                                                                                                                                                                                                                                               |
| **Pediatric / NIV**                      | Pediatric formulary section                                    | 🟡 `population` and `service_line` axes carried through 0482/0483 from day one; the validated modules are later work.                                                                                                                                                                                                                                                                                              |
| **Published outcome numbers**            | ✅                                                             | ❌ **GAP** — no instrumented benchmark to answer with.                                                                                                                                                                                                                                                                                                                                                             |

---

## 3. Where we are dramatically deeper

Everything outside the fitting moment. SleepGlad hands a DME a mask
recommendation; this platform runs the business around it — full RCM (270/271,
837P, 835 ERA, 276/277, prior auth incl. Da Vinci PAS, denials, appeals, capped
rentals, secondary/COB), a cash-pay storefront, a patient self-service portal,
an omnichannel inbox, an AI voice agent, therapy-cloud integrations, and a
platform-level multi-tenant control plane.

That is not the interesting comparison, though. **The interesting comparison is
that our fitter is the more rigorous clinical instrument** — hard safety filters,
versioned screening, structured contraindications, scoped formulary, stamped
provenance, and an explicit "I don't know" state. SleepGlad's public material
describes none of that.

---

## 4. The uncomfortable finding: the good part is switched off

Migration 0485 seeds **every** `fitter.*` flag OFF except `fitter.clinical_report`:

| Flag                         | State  | Gate                                     |
| ---------------------------- | ------ | ---------------------------------------- |
| `fitter.clinical_assessment` | OFF    | Master switch — must precede the rest    |
| `fitter.magnet_screening`    | OFF    | Needs the 0484 seed                      |
| `fitter.confidence_gating`   | OFF    | Needs 0483 (somewhere to route a review) |
| `fitter.fit_profile_v2`      | OFF    | —                                        |
| `fitter.multiframe_capture`  | OFF    | Independent of the server work           |
| `fitter.clinical_report`     | **ON** | Staff-only, purely additive              |

The blocker is real and correctly chosen: the seeded facial-geometry bands in
0486 are **estimated**, so every `mask_size_variants` row lands
`needs_clinical_review = true`, and `confidence.ts` independently caps an
unreviewed variant below high confidence. Turning the master switch on before an
RT signs off the variants a tenant actually stocks would ship estimates as
clinical output.

**So the single highest-value action here is not a feature — it is making that
RT sign-off practical and then flipping the flags in order.** Against SleepGlad
we are currently fielding the _old_ engine.

Related, and worth an owner decision rather than an engineering task: SleepGlad
publishes ~60 models across 9 manufacturers. Our seeded catalog is smaller. That
is a **data-coverage** question (which masks does this tenant actually dispense),
not an engineering gap — the catalog schema already supports far more than the
seed contains.

---

## 5. Where SleepGlad genuinely leads — the four gaps

1. **In-office "Scan Now."** Staff cannot start a fitting for a patient standing
   at the counter; invites go out by email or SMS and wait. A QR handoff plus a
   short-TTL token closes this cheaply.
2. **Refit rate as a published KPI.** This is their strongest sales asset
   ("5% vs 22–25%"). We already write every column needed —
   `mask_fit_outcomes.fit_outcome` + `mask_id`, and `fit_sessions.outcome` /
   `override_mask_model_id` / `override_reason` / `reviewed_at` / `dispensed_at`.
   Nothing reads them as a rate. This is a **read-side build with no new
   capture**, and it is the cheapest high-value item on the list.
3. **Established-patient re-fit / upgrade campaign.** Every fitter campaign we
   run targets new leads (`fitter-supply-campaign`, `first-day-nudge`,
   `reengage`). Nothing re-approaches a patient already on service whose mask is
   leaking, discontinued, or dropped from the formulary.
4. **Visual fit preview.** Their results screen shows the patient something; ours
   shows cards. The recommended answer is **not** a photorealistic 3D overlay — it
   is a to-scale diagram of the cushion footprint against the patient's own
   measurements, showing the size band explicitly ("your nose width 34 mm sits in
   the Medium cushion band, 31–37 mm"). That is cheaper, honest about the fidelity
   we actually have, and explains _why_ the size was chosen — which a black box
   does not.

**Deliberately not gap-closure:** pediatric and NIV modules (the axes are carried
so neither needs a migration, but each needs its own clinical validation), and
higher-fidelity multi-angle capture (already built, just dark).

---

## 6. Strategic read

SleepGlad competes for the **fitting moment**. We compete for the **whole
program**, and our fitting moment is already better engineered — it just isn't
switched on, isn't measured, and isn't visible.

Priority order:

1. **Make the RT sign-off practical, then activate the clinical fitter.** Nothing
   else on this list matters as much as fielding the engine we already built.
2. **Instrument fitter outcomes.** Answer "97%" with a number we can actually
   defend. Internal-first — publishing a competing accuracy claim is a business
   and legal decision, not an engineering one, and it needs this data to exist
   first.
3. **In-office scan** and **re-fit campaign** — two contained builds that close
   the remaining workflow gaps.
4. **Fit diagram** — the cheapest credibility win on the patient-facing side.

And in sales conversations, lean on the two things SleepGlad structurally cannot
match: **images never leave the patient's device**, and **a safety
contraindication is a hard filter, not a score penalty**.

---

### Sources

- <https://www.sleepglad.com/> · `/supplier-providers` · `/formulary-list` ·
  `/physicians-referral-network` · `/truckers` · `/contact`
- <https://www.vgm.com/communities/vgm-optimizes-sleep-services-with-sleepglad/>
- <https://www.vgm.com/communities/vgm-group-inc-announces-acquisition-of-sleepglad/>
- <https://hme-business.com/sleepglad-debuts-ai-driven-remote-mask-fitting-tool/>
- <https://www.homecaremag.com/news/new-mask-fitting-platform-joins-s3-resupply-family>
- <https://sleepreviewmag.com/sleep-treatments/therapy-devices/cpap-pap-devices/baxter-management-buys-sleepglad/>
- <https://www.resmed.com/en-us/health-professionals/cpap-mask-magnet-clip-hcp-guidelines/> (magnetic-clip contraindication background)
- This codebase at `655e3da` — `artifacts/`, `lib/`, `lib/resupply-db/migrations/0481`–`0487`
