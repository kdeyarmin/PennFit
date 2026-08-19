# Which mask manufacturers publish numeric size ranges (Aug 2026)

The catalog's ~290 size bands ship as **estimates**, and the clinical
fitter is gated behind an RT signing them off. The obvious way to make
that faster is to import the manufacturers' own numbers. This is what
was actually found when that was checked, so nobody has to check twice.

**Headline: only Fisher & Paykel publishes numeric ranges, and only for
three products.** Everyone else ships printable 1:1 templates.

## What each manufacturer publishes

| Manufacturer            | Models in catalog | Numeric mm/cm ranges? | Evidence                                                                                                                      |
| ----------------------- | ----------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Fisher & Paykel**     | 13                | **Yes — 3 products**  | "Mask Family Seal Size Measurements" REF 620198 gives S/M/L ranges. Names Eson 2, Simplus, Vitera only.                       |
| **ResMed**              | 28                | No                    | `airfit-f20_fitting-template-web-mm_eu_eng.pdf` — the "mm" is a print-calibration ruler (10–170 mm ticks) on a cut-out gauge. |
| **Philips Respironics** | 17                | No                    | DreamWear cushion sizing guide and Amara full-face gauge (REF 1090299) are both 1:1 cut-outs with a print-accuracy check.     |

F&P's own **per-model** guides are templates too — Vitera SUI-620483,
Simplus SUI-620495, Evora Full SUI-620938, Solo SUI-626078. The numeric
data exists only in the family-level table.

## REF 620198, three revisions

Three independently-hosted copies were retrieved and compared. They are
not identical, which is why the revision matters:

| Rev | Date    | Nasal                                  | Full face                                       |
| --- | ------- | -------------------------------------- | ----------------------------------------------- |
| A   | 2020-04 | height + width, independent ranges     | two measurements (8.9/10 cm **and** 6.6/7.5 cm) |
| B   | 2020-04 | height + width, independent ranges     | one measurement (8.9/10 cm)                     |
| C   | 2020-08 | **2-D matrix** (height × width → size) | one measurement (8.9/10 cm)                     |

REV C is newest and is what migration `0499` imports. Its nasal figures:

- **Nose width** — S: < 3.7 cm · M: 3.7–4.1 cm · L: > 4.1 cm
- **Nose height** — S: < 4.4 cm · M: 4.4–5.2 cm · L: > 5.2 cm

### The document contains an error

All three revisions print, in the nasal table:

> Greater than 5.2 cm **(2.95 inches)**

5.2 cm is **2.05** inches. The row directly above it converts the same
5.2 cm correctly. The likely mechanism is visible in REV A, whose
full-face column legitimately contains "7.5 cm (2.95 inches)" — the wrong
value appears to have been copied across.

This is the concrete reason `needs_clinical_review` is not cleared by an
import. Had the inch column been transcribed, a band would have been
~23 mm wrong.

## Why 0499 imports one model, not thirteen

- REF 620198 **names three products**: Eson 2, Simplus, Vitera. It is a
  family table, not a range-wide one — Evora Full ships **XS / S-M / L**
  (its own guide, REF 620938 REV A), so the S/M/L table plainly does not
  describe every F&P mask.
- Of those three, only **Eson 2** was imported. Simplus and Vitera are
  full face, and REF 620198's full-face block gives one measurement
  (8.9 / 10 cm) whose column header does not sit next to the numbers in
  the PDF text layer. It could be nose-to-chin or a differently-measured
  face height. Guessing would be worse than leaving them estimated.

## What the import changed, and why it was worth doing

The seeded estimates for Eson 2 diverged materially from the published
ranges:

| Size | Estimated nose width | Published nose width |
| ---- | -------------------- | -------------------- |
| S    | 26.5 – 32.1          | up to 36.9           |
| M    | 31.2 – 36.8          | 37.0 – 41.0          |
| L    | 35.9 – 41.5          | 41.1 and above       |

A patient measuring **38 mm** was pointed at **Large** by the estimate and
is pointed at **Medium** by the manufacturer. Nose height was not
populated at all by the 0486 seed, so the import also adds a dimension
the engine could not previously score this model on.

## Open ends

The published S and L rows are unbounded. `bandsFor` (`lib/fitting/tiers.ts`)
**skips** a band with a NULL endpoint, so an unbounded side would silently
stop gating. The outer edges therefore come from `PLAUSIBILITY_BOUNDS`
(`lib/fitting/confidence.ts`) — the window outside which a measurement is
already a scan failure rather than a small or large patient. Boundaries
tile at 0.1 mm, the precision the client rounds to; verified against a
real database that all 401 points from 20.0–60.0 mm land in exactly one
size, with no gaps and no overlaps.

## Known limitation: REV C is a matrix, the schema is not

`mask_size_variants` holds independent min/max per measurement, and
`scoreVariant` averages the per-band scores. REV C's nasal table is a
**matrix** whose rule is effectively "the larger dimension wins":

|              | width < 3.7 | 3.7–4.1 | > 4.1 |
| ------------ | ----------- | ------- | ----- |
| height < 4.4 | S           | M       | L     |
| 4.4–5.2      | M           | M       | L     |
| > 5.2        | L           | L       | L     |

Independent bands reproduce this for a patient squarely inside one size,
but not for mixed cases (e.g. height 40 mm, width 43 mm → the matrix says
L; independent bands score S and L equally). Encoding the matrix properly
would need a schema change and is worth its own design pass if F&P-style
matrices turn out to be common.

This was originally left as-is on the grounds that `needs_clinical_review`
kept anything from shipping at high confidence without a reviewer. **That
is no longer true** — the review cap was removed on 2026-08-19 and the
scan's own verdict governs (see `confidence.ts`). A mixed case can now
produce a confident answer from independent bands that do not reproduce
the published matrix, which raises the value of the schema work above
from "nice to have" to the honest next step for F&P nasal masks.

## Sourcing caveat

**REF 620198 was not found on fphcare.com.** Every copy retrieved was
reseller-hosted (cpap.co.uk, sonnoservice.it, sleepsolutionsommeil.com).
They agree with each other on the nasal figures, which is decent
corroboration, but confirming the current revision with F&P directly is
worth doing before this data is leaned on hard.

## Where the remaining coverage has to come from

ResMed is the largest block in the catalog (28 models) and will not yield
to document scraping. The realistic paths are physically measuring a fit
gauge and recording `physical_measurement` provenance, or asking a ResMed
representative for clinical sizing data directly. The same applies to
Philips (17 models).
