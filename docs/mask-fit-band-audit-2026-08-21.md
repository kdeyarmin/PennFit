# Mask fit-band audit — Fisher & Paykel, ResMed, Philips Respironics (Aug 2026)

A measurement-by-measurement audit of every mask the catalog carries from
the three largest manufacturers: 52 models across
[`0486_mask_catalog_seed.sql`](../lib/resupply-db/migrations/0486_mask_catalog_seed.sql),
plus the rest of the catalog, which turned out to share the same defect.

The short version: **the catalog's size bands and the fitter's
measurements were on different anatomical axes**, and 42 of those 52
models could not return an in-band size for an average adult face.
Migration
[`0511_mask_fit_band_conventions.sql`](../lib/resupply-db/migrations/0511_mask_fit_band_conventions.sql)
fixes it. Companion research on what manufacturers actually publish is in
[`mask-sizing-data-sources-2026-08-18.md`](./mask-sizing-data-sources-2026-08-18.md);
this document is what an audit of the shipped numbers found.

## 1. The defect: nose-to-chin was measured from a different landmark

The browser derives `noseToChin` from MediaPipe landmarks **4 → 152**,
nose **tip** to menton (`MEASUREMENT_LANDMARKS`,
`artifacts/cpap-fitter/src/lib/face-measurements.ts`). On MediaPipe's
canonical face model — the metric reference mesh the landmark indices are
defined against, and the fixture `confidence.ts` is pinned to — that span
is **89.4 mm**, and `ADULT_PLAUSIBILITY_BOUNDS.noseToChin` is `[55, 125]`.

The 0486 seed authored its nose-to-chin bands from textbook
**subnasale → menton** norms, which average ~65 mm. The AirFit F20's
entire five-size run spanned 54.5–80.5 mm. Three models (AirTouch F20,
Simplus, Evora Full) were on a third scale again, 88.7–131.3.

Scoring the shipped seed against the canonical adult face, using a port of
`scoreVariant`:

| Manufacturer        | Models | No in-band size for an average adult |
| ------------------- | -----: | -----------------------------------: |
| ResMed              |     22 |                                   18 |
| Philips Respironics |     17 |                                   14 |
| Fisher & Paykel     |     13 |                                   10 |
| **Total**           | **52** |                               **42** |

Two of the 52 (ResMed Pixi, Philips Wisp Pediatric) are pediatric models
and are not expected to fit an adult face; excluding them the count is
**40 of 50 adult models**.

Every one of the 42 scored **0.67 with `inBand: false`** — nose width and
mouth width matched, nose-to-chin could not, and `scoreVariant` averages
the per-band scores. The ten that _did_ come back in-band were, without
exception, the models carrying **no nose-to-chin band at all** (Swift FX,
AirFit N10, Wisp, TrueBlue, ComfortGel Blue Nasal, Eson, Opus 360, Zest,
Swift FX Nano, Mirage FX for Her).

Worked example — an average adult, AirFit F20 as shipped:

| Size | nose-to-chin band | patient reads | verdict      |
| ---- | ----------------- | ------------- | ------------ |
| XS   | 54.5 – 60.5       | 89.4          | 28.9 mm over |
| S    | 59.5 – 65.5       | 89.4          | 23.9 mm over |
| M    | 64.5 – 70.5       | 89.4          | 18.9 mm over |
| L    | 69.5 – 75.5       | 89.4          | 13.9 mm over |
| LW   | 74.5 – 80.5       | 89.4          | 8.9 mm over  |

The failure mode is the one `confidence.ts` warns about in its own header:
silent and one-directional. From the outside it is indistinguishable from
a patient with an unusual face.

## 2. Which measurements should gate which interface

The seed gated nasal masks and nasal pillows on nose-to-chin **and** mouth
width. Neither sizes those masks, and because `scoreVariant` averages
every non-NULL dimension, a dimension that does not size the mask does not
merely add nothing — it dilutes the ones that do. `0511` sets:

| Interface                       | Gating measurements                     |
| ------------------------------- | --------------------------------------- |
| full face / hybrid / total face | nose width · nose-to-chin · mouth width |
| nasal / nasal cradle            | nose width · nose height                |
| nasal pillow                    | nose width                              |

This follows the precedent `0499` set for Eson 2 (it cleared nose-to-chin
and mouth width because the cited manufacturer table says nothing about
either), and it matches how the one manufacturer who publishes numbers
sizes its own range: F&P's REF 620198 gates nasal masks on nose height and
nose width, and full face masks on a vertical face span.

## 3. How the replacement bands were derived

Not from textbook norms — that is what produced the defect. From the
pipeline's own calibration constants:

- **anchor** — the canonical face _as this pipeline measures it_: nose
  width 35.72, nose height 29.36, nose-to-chin 89.40, mouth width
  49.12 mm;
- **envelope** — ±18% of that anchor, the ±3 SD population spread at
  SD ≈ 6% of the mean that `plausibility-windows.test.ts` already requires
  every window to clear;
- **partition** — split across the model's size run, each bucket widened
  by 10% of its width so adjacent sizes overlap rather than butt (the 0486
  seed's own rule, kept);
- **outer edges** — the smallest and largest sizes run out to
  `PLAUSIBILITY_BOUNDS`, so any measurement the pipeline still accepts as
  a face lands in some size. This is the rule `0499` established for Eson
  2's open-ended published rows, now applied uniformly.

Models with the same size run therefore get the same bands. That is
deliberate and more honest than the alternative: the per-model differences
in the seed were generated, not sourced, and there is no evidence the F20
fits taller faces than the F30.

**Provenance is unchanged.** Every rewritten band stays
`fit_data_source = 'estimated'` with `needs_clinical_review = true`, and
`fit_data_source_ref` stays NULL. This migration makes the numbers
estimates of the _right quantity_ instead of accurate estimates of the
wrong one; it does not make them manufacturer data. The per-tenant RT
sign-off remains the gate.

### Wide sizes are not simply bigger

"Small Wide" means a small nose height with a **wider** nose. A wide size
therefore shares its base size's height band and steps one bucket up in
width. The seed treated the AirFit N30i as the linear ladder
S < M < SW < W, which points a small-wide patient two sizes off.

The step-up applies only where the run also carries the plain base size —
the AirFit F40 ships Small Wide / Medium / Large with no plain Small, so
it is an ordinary three-step ladder whose smallest size merely has "wide"
in its name.

## 4. Size runs that did not match what the manufacturer ships

Verified against ResMed's own storefront (`eshop.resmed.com`) and support
pages. Every one of these was invented by the seed:

| Model       | Seeded                           | Actually ships |
| ----------- | -------------------------------- | -------------- |
| AirFit F20  | XS, S, M, L, LW                  | S, M, L        |
| AirFit N20  | XS, S, M, LW                     | S, M, L        |
| AirFit F30  | S, M, Wide-S, Wide-M             | S, M           |
| AirFit N30  | S, M, Wide-S, Wide-M             | S, SW, M       |
| AirFit F30i | S, M, L, Wide-S, Wide-M, Wide-L  | S, SW, M, W    |
| AirFit F40  | S, M, L                          | SW, M, L       |
| AirFit N30i | S, M, SW, W (in that sort order) | S, SW, M, W    |

Sizes that never existed are set `status = 'discontinued'` with their
bands nulled, rather than deleted: `fit_sessions` carries plain (NO
ACTION) foreign keys onto `mask_size_variants`, so deleting a row a past
session recommended would fail the migration outright. `scoreFacialFit`
already skips a discontinued variant, and `scoreVariant` returns null for
one with no geometry, so the row stops being recommendable two ways over
while every historical reference keeps resolving. Sizes the manufacturer
prints differently are renamed **in place**, preserving the row UUID so
formulary entries, past sessions and referrals keep resolving.

The magnet-free twins `0493` clones off the F20 and F30i inherit both
corrections.

### The second pass (0512) — every remaining run resolved

The runs this section originally deferred ("checked against retailer
listings only … the obvious next pass") were subsequently verified against
manufacturer-hosted documents or two independent per-size-SKU sources and
corrected in migration `0512`. The compiled per-model evidence — every
model, seeded vs verified run, citation — lives in
[`mask-size-run-registry-2026-08-21.md`](./mask-size-run-registry-2026-08-21.md).
Highlights: the Philips Amara's whole run was shifted one size (seeded
S/M/L/XL vs the real Petite/S/M/L); the AirFit N10 and Swift FX Nano ship
S/Standard/Wide, not S/M/L (N10 confirmed by ResMed's own sizing
brochure); the Wisp is Petite / S-M / L / XL; TrueBlue has a fifth (MW)
size; the DreamWear gel pillows' XS never existed (Philips' own brochure);
and **"DreamWear Full Face Gel" is not a product at all** — the seed
invented it, and 0512 retires the model.

### The legacy storefront engine had the same defect — fixed in the same pass

The DB catalog is the clinical fitter's data, but the live, invite-gated
`/api/recommend` path still runs on the hardcoded `maskCatalog.ts`, whose
hand-authored `fitRanges` were on the same subnasale scale. Under that
engine's semantics (`recommendSize` sizes full-face masks by linearly
partitioning `[noseToChinMin, noseToChinMax]`), an average adult clamped
to the **largest size with a spurious "marginal fit" warning** on
essentially every full-face mask, and `scoreFitMatch` zeroed the
nose-to-chin term (weight 0.35), systematically de-ranking the whole
interface. Every `fitRanges` block now carries the canonical-face ±18%
envelope on the pipeline's axes — geometry stops pretending to
distinguish masks, the linear size partition reproduces the DB bands
(same anchor, same envelope), and only a genuine ±3 SD outlier sees the
clamp warning. Size runs were corrected to the verified ones and the
fabricated DreamWear Full Face Gel entry removed. Pinned by
`data/maskCatalog.conventions.test.ts`.

## 5. Eson 2 — the manufacturer import had the same class of problem

`0499` imported F&P REF 620198's nasal table and marked the rows
`fit_data_source = 'manufacturer'`. Auditing it against the source
document — REV B was retrieved and rendered, and the 2026-08-18 comparison
records REV B and REV C as carrying identical nasal figures:

- The **nose width** column maps cleanly. F&P measure "the widest part of
  the nose", which is the alar span this pipeline reads at landmarks
  129/358. Kept.
- The **nose height** column does not. F&P's diagram measures from the
  bridge of the nose to just _below_ the nose (≈ nasion → subnasale); the
  pipeline's `noseHeight` is landmark 6 → landmark 4, bridge → **tip**,
  ~29 mm on the canonical face against F&P's 44–52 mm Medium band.

Two live consequences: `ADULT_PLAUSIBILITY_BOUNDS.noseHeight` is `[18,45]`
since the windows were recalibrated against the canonical face, but 0499
wrote its open ends from the pre-calibration window (25–70). **Eson 2
Large (52.1–70.0) sits entirely above the ceiling and is unreachable**,
Medium is reachable across a 1 mm sliver, and every plausible reading
resolves to Small.

`0511` clears the height bands rather than converting them. The conversion
needs subnasale, which is not among the canonical vertices this repository
pins, and inventing its offset would be exactly the guess 0499 refused to
make for REF 620198's full-face column. The nose-width band is kept with
its open ends realigned to the current window, and the citation is
narrowed to name the column that was actually mappable.

### The full-face column, resolved

`mask-sizing-data-sources-2026-08-18.md` left REF 620198's full-face block
(8.9 / 10 cm) open because "the column header does not sit next to the
numbers in the PDF text layer". Rendering the page settles what it is: the
full-face diagram is a **profile view** whose dimension arrow runs from
the **nose bridge**, at eye level, down past the lower lip to the chin.

It is still not importable — the pipeline's `noseToChin` is anchored at
the nose **tip**, not the bridge, and 8.9–10 cm reconciles with neither
tip→menton (89.4 mm canonical) nor nasion→menton (118.8 mm) on the
reference face. But the reason is now specific rather than "the header is
missing", and the next reviewer can start from F&P's own per-model guides
(Eson 2/Simplus REF 185048403, Vitera REF 612027) which give the
measuring instruction in words.

## 6. ResMed and Philips still publish no numbers

Re-confirmed. `airfit-f20_fitting-template-web-mm_eu_eng.pdf` was
retrieved and its text and vector geometry extracted: the "10 mm … 170 mm"
markings are a **print-calibration ruler** down the right edge of a 1:1
cut-out gauge ("Actual Size: 140 mm (Width) x 175 mm (Height)"), not
sizing ranges. Same for the AirTouch F20 template and Philips' DreamWear
and Amara gauges.

Reverse-engineering the cut-out outlines was considered and rejected: the
templates are stylised illustrations with a mask overlay, and numbers
measured off them would carry a provenance claim the artwork cannot
support. The realistic paths remain the ones the earlier note identified —
physically measuring a fit gauge and recording `measured` provenance, or
asking a manufacturer representative for clinical sizing data.

## 7. What holds this in place

`artifacts/resupply-api/src/lib/fitting/catalog-bands.test.ts` — 260 test
cases run against the committed migration text (no database needed),
using the real `scoreVariant`:

1. **an average adult face fits every adult mask** — the direct regression
   test for §1;
2. **every band sits inside its population's plausibility window** — a
   band edge outside it is unreachable, which is what stranded Eson 2
   Large and the AirFit N20's seeded Large Wide;
3. **the size run tiles its window with no gaps**, stepped at 0.1 mm, the
   precision the client rounds to;
4. **only the dimensions that size an interface gate it** (§2), including
   that every full-face run still brackets the canonical adult;
5. **size runs match what the manufacturer ships** (§4);
6. the canonical-face constants agree with `plausibility-windows.test.ts`,
   so a change to a landmark pair fails here too.

Reverting the AirFit F20 rows to the seed's values fails 1, 3 and 4 —
including, in as many words, `expected 75.5 to be greater than 89.4`.

The whole chain, `0511` included, was applied to a scratch Postgres 16 and
the resulting `mask_size_variants` re-queried: zero bands outside the
windows, zero adult models without an in-band size, and provenance
unchanged at 253 `estimated` + 3 `manufacturer`, all still
`needs_clinical_review = true`.

## 8. Tenants who authored their own bands

`0511` touches platform rows only (`org_id IS NULL`). A tenant that
authored its own nose-to-chin bands against the old seed has **the same
defect** and has to re-derive them — the correction cannot be applied for
them, because a tenant's catalog data is its own. Worth a note in the
catalog admin UI next to any tenant-owned variant carrying a nose-to-chin
band.
