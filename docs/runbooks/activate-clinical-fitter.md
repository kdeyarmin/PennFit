# Runbook: Activate the clinical mask fitter

Operator checklist for turning on the clinical fitting core — the Mask
Intelligence Catalog, the tiered assessment engine, magnetic-component
safety screening, and confidence gating — which ships **built but OFF**
(migrations `0481`–`0486`, flags seeded by
[`0485_fitter_clinical_flags.sql`](../../lib/resupply-db/migrations/0485_fitter_clinical_flags.sql)).

Companion to
[`docs/competitor-analysis-sleepglad-2026-08-18.md`](../competitor-analysis-sleepglad-2026-08-18.md),
which explains _why_ this matters commercially. This one is the _how_.

> **The short version.** Until step A is done, do not flip anything. The
> catalog's millimetre bands are **estimates**, and the engine knows it —
> an unreviewed size band can never produce a high-confidence
> recommendation. Turning the master switch on first doesn't ship bad
> recommendations (the cap holds), it ships a fitter that routes almost
> everything to human review, which looks broken. Do the sign-off first.

All six switches are **runtime feature flags**, flipped in
**Control Center** (`/admin/control-center`), effective within ~5 s with
no deploy. There are no env-var gates in this subsystem.

---

## A. Prerequisite — clear the clinical review queue

**Who:** a respiratory therapist or clinical supervisor (the queue is
gated on `formulary.manage`, not a generic tools permission).
**Where:** `/admin/fitter/catalog`.
**Effort:** the seed ships ~250 size variants; a tenant only needs the
models it actually dispenses.

Why this is a hard prerequisite, in the codebase's own words: the 0486
seed bands are "clinically-reasoned estimates rather than published
manufacturer data," every row lands `needs_clinical_review = true`, and
`lib/fitting/confidence.ts` independently caps an unreviewed variant
below high confidence. The flag is the second line of defence, not the
only one.

Procedure, per model you dispense:

1. Filter to **Showing: needs review** (the default view) and open a
   model's sizes.
2. Open that manufacturer's fitting guide / spec sheet.
3. Fill in **Sign-off source** — the class of evidence and a reference
   (e.g. "AirFit N20 fitting template rev C"). This is recorded on every
   sign-off you then make and printed on the fit report, which is what
   makes the report evidence rather than an assertion (migration `0491`).
4. Check each size's millimetre bands against the guide. Correct any that
   are wrong **before** signing off — a sign-off approves the numbers as
   they stand.
5. **Sign off all N remaining** for the model, or size by size.

Notes:

- Sign-off is **per tenant**. It lands in `mask_variant_reviews`, never on
  the shared `mask_size_variants.needs_clinical_review` flag — one DME's
  RT must not lift another DME's confidence ceiling.
- The source field is **optional by design**. A reviewer going on
  experience should pick "Clinical judgement (no document)" rather than
  overclaim a citation. Never leave it blank to save time — a blank reads
  as "source not recorded" forever.
- **Check:** filter to needs-review and confirm the models you dispense
  are gone from the queue.

---

## B. Flip the flags, in this order

The order is not cosmetic — 0485's header encodes the dependencies.

### B1. `fitter.clinical_assessment` — the master switch

Makes the engine read the DB catalog and this tenant's formulary at all.
Everything below is inert without it.

- **Precondition:** step A complete for the models you dispense, **and**
  an active formulary published at `/admin/fitter/formulary`.
- **Check:** run a fitting (`/admin/fitter-invites` → complete the link
  yourself) and confirm a `fit_sessions` row appears at
  `/admin/fit-sessions` carrying a formulary version.
- **Rollback:** flip OFF. The legacy engine
  (`lib/storefront/recommendationEngine.ts`) resumes immediately; no data
  is lost and existing fit sessions stay readable.

### B2. `fitter.magnet_screening` — patient-safety screen

Asks the patient (and about their household) about implanted devices, and
excludes masks with magnetic headgear clips on a positive **or unsure**
answer. Requires B1.

- **Precondition:** B1 on. Review the seeded question wording at least
  once — it is what the patient sees and what the report cites
  (`magnetic_implant@v1`).
- **Confirm** the catalog's `has_magnetic_components` is right for the
  models you stock; the exclusion keys off that column. A mask wrongly
  marked magnet-free is the one failure mode that matters here.
- **Check:** run a fitting answering "yes" to an implanted device and
  confirm magnetic masks are excluded, with the exclusion visible in the
  fit report's "Ruled out" section.
- **Rollback:** flip OFF. Do this immediately if the screen is firing
  wrongly — an over-exclusion is an annoyance, an under-exclusion is a
  safety issue.

### B3. `fitter.confidence_gating` — exception handling

Low-confidence fittings stop short of an automated recommendation and ask
for a better scan or an RT review instead of guessing. A prescribed
pressure above a mask's rated maximum becomes an exclusion rather than a
scoring penalty. Requires B1 and somewhere to route a review.

- **Precondition:** B1 on, and **someone is actually working**
  `/admin/fit-sessions`. This flag creates a queue; an unattended queue is
  worse than no gating, because patients wait on a review nobody does.
- **Check:** the fit-review queue at `/admin/fit-sessions` receives
  low-confidence sessions and they can be approved or overridden.
- **Rollback:** flip OFF. Gated sessions resolve to a recommendation
  again; already-queued sessions stay reviewable.

### B4. `fitter.fit_profile_v2` — the expanded questionnaire

~20 questions across six short chapters, with branching so a typical
patient answers far fewer. OFF keeps the original 11.

- **Precondition:** B1 on. This one is patient-visible and lengthens the
  flow — watch fitter completion rate at
  `/admin/analytics/acquisition-funnel` after flipping.
- **Rollback:** flip OFF. Answers already captured stay on their sessions.

### B5. `fitter.multiframe_capture` — guided multi-angle scan

Independent of the server work above; can be flipped at any point, on its
own. Guided multi-angle capture with live quality checks (lighting,
distance, head position, obstruction, movement).

- **Precondition:** none beyond wanting it. Still patient-visible — watch
  the capture drop-off in the acquisition funnel, and the scan-failure
  reason mix.
- **Rollback:** flip OFF; capture returns to single-frame.

### B6. `fitter.clinical_report` — already ON

Seeded **ON** and staff-only. Nothing to do. Leave it on: it is the
downloadable PDF that makes every step above auditable.

---

## C. The re-fit campaign is gated twice — flag alone does nothing

`fitter.refit_campaign` (migration `0490`, seeded OFF) offers a fresh fitting
to patients who reported a leaking or uncomfortable fit, and to patients on a
discontinued mask. Unlike the flags above it needs **two** switches:

1. **`RESUPPLY_REFIT_CAMPAIGN_ENABLED=1`** on Railway (Service → Variables).
   This registers the worker at boot; without it the job never starts and the
   flag has nothing to enable. Takes effect on the next deploy.
2. **`fitter.refit_campaign`** ON in Control Center, per tenant.

Flipping only the flag is the failure everyone hits: the toggle reads as ON
and nothing is ever sent, with no error anywhere. Set the variable first,
confirm the deploy, then flip the flag.

- **Precondition:** the tenant's SMS and/or email sender is configured, and
  patient consent for those channels is in order — this contacts patients who
  did not ask to be contacted.
- **Check:** after a nightly run (19:20 UTC), look for a
  `refit_campaign.tick` log line with a non-zero `sent`.
- **Rollback:** flip the flag OFF; sending stops within ~5s, no deploy needed.

---

## D. What makes the outcome KPIs fill in

`/admin/analytics/fitter-outcomes` reads columns that only certain actions
write, so two of its tiles stay empty until the matching workflow is
actually being used. This is not a bug to chase:

| Tile                        | Fills in when                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Recommendation accepted** | A clinician approves or overrides a fitting in the review queue. Until someone works the queue every fitting is _undecided_, which is honest — nobody has judged it.                                   |
| **Dispensed**               | A cash-pay order that came from a fitting is marked **delivered** (carrier webhook, or the admin "mark delivered" action). Payment alone does not count: a mask in a warehouse has not been dispensed. |

Two consequences worth stating plainly, because they look like data loss:

- **Insurance fittings never count as dispensed.** "Choose this mask" creates
  an order request, not a shop order, and the link column is a foreign key to
  `shop_orders`. Dispensing measures the cash-pay path only.
- **A fitting only links to an order placed from the fitter's own
  "Buy without insurance" button**, within 24 hours, in the same browser. A
  patient who browses the shop separately and buys the same mask is a
  different journey and is deliberately not attributed to the fitting.

---

## Recommended order

1. **A** — clear the review queue for the models you dispense. Everything
   else is blocked on this.
2. **B1** `fitter.clinical_assessment`, then watch one real fitting end to
   end before continuing.
3. **B2** `fitter.magnet_screening` — the safety win, and the one with a
   published clinical rationale behind it.
4. **B3** `fitter.confidence_gating` — only once someone owns the review
   queue.
5. **B4** / **B5** — patient-visible polish; flip one at a time and watch
   completion rate between them.

## Rollback

Every flag is independently reversible in Control Center with no deploy
and no data migration. Flipping `fitter.clinical_assessment` OFF disables
the whole subsystem in one action regardless of the others' state — that
is the panic switch.

Clinical sign-offs in `mask_variant_reviews` survive a rollback, so
re-enabling later does not mean redoing step A.
