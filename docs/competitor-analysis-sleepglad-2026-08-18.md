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

## 7. Update — shipped in this pass

The four gaps in §5 were acted on the same day, and §4's activation blocker
was cleared enough to be workable. What changed:

| Gap                                       | Outcome               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4 Activation blocked on the review queue | **Shipped (tooling)** | Batch sign-off for a whole model's size run, plus **provenance** on every sign-off (migration `0491`): `source_kind` + `source_ref`, so the fit report can cite the manufacturer chart a band was verified against instead of just asserting that someone approved it. Runbook: [`docs/runbooks/activate-clinical-fitter.md`](./runbooks/activate-clinical-fitter.md). **No flag was flipped** — that is the owner's decision, and clearing the queue for the models a tenant dispenses is still a prerequisite.                                                                                                           |
| §5.1 In-office "Scan Now"                 | **Shipped**           | `in_office` invite channel (migration `0489`): nothing is sent, the signed link is handed over as a QR the patient scans. No email or phone required. 12-hour token rather than 30 days, because the QR sits on a staff screen in a semi-public space.                                                                                                                                                                                                                                                                                                                                                                     |
| §5.2 Refit rate as a KPI                  | **Shipped**           | `/admin/analytics/fitter-outcomes` — refit rate, recommendation acceptance and override reasons, scan quality, confidence mix, time-to-review, split by entry point. Read-side only; every column already existed. Internal-first: publishing a competing accuracy claim is a separate business decision, and this is the data it would need.                                                                                                                                                                                                                                                                              |
| §5.3 Established-patient re-fit           | **Shipped, OFF**      | Daily scan offering a fresh fitting to patients who reported a leaking or uncomfortable fit, and to patients on a discontinued mask (migration `0490`, flag seeded OFF). One message per patient per quarter.                                                                                                                                                                                                                                                                                                                                                                                                              |
| §5.4 Visual fit preview                   | **Shipped**           | A to-scale diagram of the patient's own measurements against the mask's published fit range, on `/results` — not a mask rendered onto a model of their face. See §5.4 for why.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §5.2 follow-up — closing the outcome loop | **Shipped**           | 0483 declared `ordered_mask_model_id` / `ordered_variant_id` / `shop_order_id` / `dispensed_at` and nothing ever wrote them, so acceptance and dispensing were structurally empty. The link now rides the Stripe Checkout Session's metadata from the fitter's cart through the webhook, and `dispensed_at` is stamped on **delivery** (both the carrier webhook and the admin mark-delivered action), not on payment. This also added the cash-pay CTA to the clinical results — turning `fitter.clinical_assessment` on used to remove the "buy without insurance" button, because only the legacy results card had one. |

Two things were deliberately **not** built, and both are worth knowing before
someone re-opens them:

- **Scan-failure reason codes are not in the KPI page.** The SPA emits them,
  but they land in `public.usage_events`, which has no `org_id` — reading it
  into a tenant-scoped report would show one DME another DME's scan failures.
  Scan health comes from the org-scoped `fit_sessions.scan_quality_grade`
  instead.
- **Insurance fittings still can't be dispensed-tracked.** `fit_sessions.shop_order_id`
  is a foreign key to `shop_orders`, so only the cash-pay path can close the
  loop. A fitting that goes to insurance through "Choose this mask" becomes an
  order request, which has no column to hang off. Making that count means a
  second link column and a decision about what "dispensed" means when a third
  party ships the mask.
- **A mask dropping out of the formulary is not a re-fit trigger.** It needs
  per-patient formulary resolution against payer, location and contract, and
  0482's semantics say a payer-scoped rule must not fire when the payer is
  unknown. Getting it wrong means telling a patient their working mask is
  unavailable when it isn't. It needs its own design pass.

Still open from §5, unchanged: **pediatric and NIV service lines** (the axes
are carried through 0482/0483, but each needs its own clinical validation)
and **higher-fidelity multi-angle capture** (built, behind
`fitter.multiframe_capture`, still OFF).

---

## 8. Update — second pass (same day, PR #1267)

An independent re-run of the research confirmed §1–§6 and turned up one
finding this document missed, because it sat _under_ a feature rather than
beside one. Chasing SleepGlad's "automated magnetic clip contraindication
documentation" into our own catalog showed the tier-1 magnet safety filter
was running on wrong data in both directions:

- **Eight magnetic masks were seeded non-magnetic** — ResMed AirFit F30
  and N10 (both on the FDA Class I recall list), AirFit F40 (magnets per
  ResMed's own IFU), and Philips Amara View, DreamWear FF (+ Gel), Wisp
  and Wisp Youth (all named in Philips' 6 Sep 2022 field safety notice).
  With `fitter.magnet_screening` on, an implant patient was correctly kept
  off the F20 family and could then be handed an F30 or a Wisp.
- **One magnet-free mask was seeded magnetic** — the F&P Evora Full, when
  Fisher & Paykel market their entire range as magnet-free: excluding it
  removed a safe option from exactly the patients who need it.

Fixed in migration `0492`. In the same pass, migration `0493` closed the
gap SleepGlad's formulary exposes with its "AirFit F20 Non-Magnetic" /
"AirFit F30i Non-Magnetic" entries: `magnet_free_variant_slug` had existed
since 0481 with zero rows populating it and nothing reading it. The twins
are now seeded as their own model rows and the engine offers the
same-model magnet-free swap first, naming it on the exclusion record only
when it actually survived every filter.

Also in this pass: catalog parity additions (`0494` — Inogen Aurora,
Rain8 AmeriFlex, AirFit X30i; Genadyne deliberately skipped, unverifiable),
platform band provenance with a citation-or-estimated CHECK (`0495`),
fitting-documentation links + sign-off pre-fill (`0496` + catalog UI), and
a re-verification of §7's four shipped gap-closures which found and fixed
the clinical cash-pay resolver matching on an identifier space the shop
isn't keyed on — the reason the §7 outcome-loop closure never actually
produced a linked order.

**Coverage, stated honestly:** every size band in the catalog remains
`estimated` / `needs_clinical_review = true` — nothing in this pass
upgraded a band, because manufacturers publish printable 1:1 templates,
not millimetre ranges, and a transcribed number is not a reviewed one.
What changed is that when sourced data does land, it must carry a citation
(`0495`'s CHECK), and five ResMed models now link straight to their
manufacturer documentation from the sign-off queue.

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
