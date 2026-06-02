# Top national insurance plans available in Pennsylvania → payer_profiles map

This is the canonical mapping behind the request to "add the top national
insurance plans available in Pennsylvania" to `resupply.payer_profiles`. It
lists the largest national health insurers, whether each is actually sold in
PA, and the catalog slug that represents it (existing, newly added in
migration `0208_national_payers_top25.sql`, or deliberately excluded).

**Researched:** 2026-06 · **Scope:** national carriers, ranked roughly by US
medical membership, filtered to Pennsylvania availability for the 2026 plan
year. PA-only regional plans (UPMC, Geisinger) and the PA Medicaid MCOs are
catalogued separately (0128/0149) and are not "national," so they are out of
scope here even though they are large in PA.

## Why "national" + "in PA" is the filter that matters

A payer being large nationally does **not** mean a PA DME supplier can bill
it. Pennsylvania's Blue plans are independent licensees (Highmark,
Independence/IBX, Capital BlueCross) — so **Anthem/Elevance is not a PA Blue**,
and out-of-state Anthem members are billed through the local PA Blue via
BlueCard. Several top-10 national insurers (Kaiser, HCSC, Florida Blue,
Molina, WellPoint) simply do not sell in PA at all. The table below records
that reality so we don't seed coverage that doesn't exist.

## The map

| #   | National plan / carrier                       | Parent                          | In PA (2026)?                      | Catalog slug                               | Status                      |
| --- | --------------------------------------------- | ------------------------------- | ---------------------------------- | ------------------------------------------ | --------------------------- |
| 1   | UnitedHealthcare (commercial)                 | UnitedHealth Group              | Yes                                | `uhc_commercial`                           | existing (0128)             |
| 2   | UnitedHealthcare Community Plan (PA Medicaid) | UnitedHealth Group              | Yes                                | `uhc_community_plan_pa`                    | existing (0128)             |
| 3   | UnitedHealthcare Dual Complete (D-SNP)        | UnitedHealth Group              | Yes                                | `uhc_dual_complete_pa`                     | existing (0149)             |
| 4   | Aetna (commercial)                            | CVS Health                      | Yes                                | `aetna_commercial`                         | existing (0128)             |
| 5   | Aetna Medicare                                | CVS Health                      | Yes                                | `aetna_medicare_pa`                        | existing (0128)             |
| 6   | Cigna Healthcare (commercial)                 | The Cigna Group                 | Yes                                | `cigna_commercial`                         | existing (0128)             |
| 7   | Cigna Healthcare Medicare                     | The Cigna Group                 | Yes                                | `cigna_medicare_pa`                        | existing (0149)             |
| 8   | Humana (commercial + MA)                      | Humana Inc.                     | Yes                                | `humana_commercial`, `humana_gold_plus_pa` | existing (0128/0149)        |
| 9   | Centene — PA Medicaid (Medical Assistance)    | Centene                         | Yes                                | `pa_health_and_wellness`                   | existing (0128)             |
| 10  | Centene — Wellcare (MA / D-SNP)               | Centene                         | Yes                                | `wellcare_pa`                              | existing (0149)             |
| 11  | **Centene — Ambetter (ACA marketplace)**      | Centene                         | **Yes (Pennie, 39 cos.)**          | **`ambetter_pa`**                          | **NEW (0208)**              |
| 12  | Highmark Blue Cross Blue Shield               | Highmark Health                 | Yes                                | `highmark_bcbs_pa` (+ siblings)            | existing (0128)             |
| 13  | Independence Blue Cross                       | Independence Health Group       | Yes                                | `ibx` (+ Keystone/Personal Choice 65)      | existing (0128/0149)        |
| 14  | Capital BlueCross                             | Capital BlueCross               | Yes                                | `capital_bc`, `capital_blue_senior`        | existing (0128/0149)        |
| 15  | **BCBS Federal Employee Program (FEP)**       | BCBSA (Highmark in PA)          | **Yes (via Highmark)**             | **`bcbs_fep`**                             | **NEW (0208)**              |
| 16  | **Anthem / Elevance Health**                  | Elevance Health                 | **Out-of-state Blue via BlueCard** | **`anthem_bluecard`**                      | **NEW (0208) — router row** |
| 17  | **Oscar Health**                              | Oscar Health, Inc.              | **Yes (Pennie, 13 cos.)**          | **`oscar_health_pa`**                      | **NEW (0208)**              |
| 18  | **GEHA (FEHB, UHC network)**                  | GEHA                            | **Yes (federal)**                  | **`geha`**                                 | **NEW (0208)**              |
| 19  | TRICARE East                                  | Humana Government               | Yes                                | `tricare_east`                             | existing (0128)             |
| 20  | VA Community Care Network (Region 1)          | Optum / UnitedHealth Group      | Yes                                | `va_ccn_region1`                           | existing (0128)             |
| 21  | Devoted Health (MA)                           | Devoted Health                  | Yes                                | `devoted_health_pa`                        | existing (0149)             |
| 22  | Clover Health (MA)                            | Clover Health                   | Yes                                | `clover_health_pa`                         | existing (0149)             |
| 23  | AARP / UnitedHealthcare Medicare Supplement   | UnitedHealth Group              | Yes                                | `aarp_uhc_medsup`                          | existing (0149)             |
| 24  | **Mutual of Omaha Medicare Supplement**       | Mutual of Omaha                 | **Yes (Medigap)**                  | **`mutual_of_omaha_medsup`**               | **NEW (0208)**              |
| 25  | National TPAs — Meritain (Aetna), UMR (UHC)   | CVS Health / UnitedHealth Group | Yes                                | `meritain_health`, `umr`                   | existing (0149)             |

**Net change in 0208:** 6 new rows — `ambetter_pa`, `oscar_health_pa`,
`bcbs_fep`, `geha`, `anthem_bluecard`, `mutual_of_omaha_medsup`.

## Deliberately excluded (large nationally, but NOT sold in PA)

These are documented so a future reviewer doesn't "re-add" them by mistake.

| Carrier                                 | Why excluded                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Molina Healthcare**                   | Not on Pennie's 2026 14-carrier list; no PA Medicare Advantage and no PA Medicaid contract; announced it is exiting traditional Medicare Advantage after 2026. Seeding a PA row would imply coverage that does not exist. |
| **WellPoint** (Elevance; ex-Amerigroup) | Medicare Advantage in only AZ, IA, NJ, TN, TX, WA, WV — no Pennsylvania plan. (Payer IDs `WLPNT` / legacy `26375` kept here only as a reference for the 7 states it serves.)                                              |
| **Kaiser Permanente**                   | Does not operate in Pennsylvania.                                                                                                                                                                                         |
| **Health Care Service Corp (HCSC)**     | Operates in IL, TX, NM, OK, MT — not PA.                                                                                                                                                                                  |
| **GuideWell / Florida Blue**            | Florida only.                                                                                                                                                                                                             |

## Notes on the new rows

- **`ambetter_pa`** shares EDI payer ID **68069** with Centene's PA Medicaid
  row (`pa_health_and_wellness`); the line of business is told apart by the
  member card, not the payer ID. Medical-PA fax (844-827-4948) is the one PA
  fax stored — it is printed on Ambetter's official Quick Reference Guide.
- **`bcbs_fep`** reuses Highmark's **54771** because Highmark administers FEP
  in PA. Member IDs start with `R`. FEP is excluded from BlueCard — file to
  Highmark, not the home Blue plan.
- **`geha`** uses **39026** — the UHC/UMR-platform payer ID GEHA migrated to
  (the legacy **44054** is retired). 39026 is shared with the `umr` TPA row.
- **`anthem_bluecard`** is an **umbrella / router row** (no EDI ID, like the
  existing `pa_chip` row): it exists so coverage-resolution can attach a
  `payer_profile` to a free-text Anthem card, with notes instructing the CSR
  to bill the local PA Blue (Highmark / IBX / Capital) via BlueCard.
- **`oscar_health_pa`** is `edi_enrollment_status='pending'` until the Office
  Ally enrollment for payer ID `OSCAR` is confirmed; sleep/CPAP PA is
  delegated to eviCore.
- **`mutual_of_omaha_medsup`** is a Medigap crossover payer (pays after
  Medicare, no PA). Its dedicated claims PO Box was not verified and is left
  NULL rather than guessed.

A few fields are intentionally left **NULL** rather than guessed, and can be
filled per-row through the admin edit drawer once confirmed (no deploy needed):

- **`timely_filing_days` for `bcbs_fep` and `geha`** — both are FEHB plans
  whose deadline is "file by Dec 31 of the year after the date of service,"
  which is not a fixed day count, so the rule lives in `notes` instead of a
  number that would over-flag still-timely claims.
- **Mutual of Omaha's** dedicated Medigap claims PO Box and member-ID format.
- **Oscar's** verified Office Ally enrollment for payer ID `OSCAR`
  (`edi_enrollment_status='pending'` until confirmed).

Values that **are** seeded but remain best-effort: **Oscar's
`timely_filing_days` is a working 180-day value** (agreement-dependent — revise
per the provider contract), and `requires_prior_auth_dme` is set `true` on the
commercial/federal rows with the specific CPAP/E0601 pathway captured in
`notes` (Availity, eviCore, Highmark FEP UM) rather than a structured per-code
field.
