# PA DME-relevant payers → payer_profiles map (migration 0210)

A third wave (after [`payer-top-25-national-pa.md`](./payer-top-25-national-pa.md)
and [`payer-additional-pa-plausible.md`](./payer-additional-pa-plausible.md)).
`0210` adds the remaining payer classes a Pennsylvania DME/CPAP supplier
touches, and — per request — fills **every field that can be verified** for
each row (claims + appeals addresses, both phones, portal, timely filing, PA
method/turnaround, modifiers, member-ID hint, EDI IDs, and the jsonb
representations). Only genuinely unverifiable or not-applicable fields are left
NULL, each flagged in `notes`; no fax number is guessed.

**Researched:** 2026-06.

## The 25 new rows

| Slug                               | Payer                                        | LOB                | Payer ID / routing              | Claims address                               | Timely   |
| ---------------------------------- | -------------------------------------------- | ------------------ | ------------------------------- | -------------------------------------------- | -------- |
| `upmc_community_healthchoices`     | UPMC Community HealthChoices                 | medicaid_mco       | 23281                           | e-submit (PO Box 2999, Pittsburgh PA)        | 180 d    |
| `keystone_first_chc`               | Keystone First Community HealthChoices       | medicaid_mco       | 42344 (ERA ECHO 58379)          | PO Box 7146, London KY 40742                 | 180 d    |
| `pa_health_wellness_chc`           | PA Health & Wellness Community HealthChoices | medicaid_mco       | 68069                           | e-submit (≠ AmeriHealth Caritas CHC 77062)   | 180 d    |
| `champva`                          | CHAMPVA (VA dependents)                      | federal            | 84146 (Change Healthcare)       | PO Box 30750, Tampa FL 33630                 | ~365 d   |
| `railroad_medicare`                | Railroad Medicare — Part B (Palmetto GBA)    | medicare_part_b    | 00882                           | PO Box 10066, Augusta GA 30999               | 365 d    |
| `tricare_for_life`                 | TRICARE For Life (WPS)                       | federal            | TDFIC (≠ 99726 West)            | PO Box 7889, Madison WI 53707                | 365 d    |
| `federal_black_lung`               | Federal Black Lung Program (DOL DCMWC)       | federal            | OWCP portal (owcpmed.dol.gov)   | PO Box 8307, London KY 40742                 | —        |
| `aetna_medicare_dsnp_pa`           | Aetna Medicare D-SNP (PA)                    | medicare_advantage | 60054                           | PO Box 981106, El Paso TX 79998              | 365 d    |
| `cigna_preferred_medicare_pa`      | Cigna Preferred Medicare (→ HealthSpring)    | medicare_advantage | 63092                           | PO Box 20002, Nashville TN 37202             | 90 d     |
| `highmark_community_blue_medicare` | Highmark Community Blue Medicare HMO         | medicare_advantage | 54771                           | PO Box 2718, Pittsburgh PA 15230             | 365 d    |
| `upmc_for_life_dual`               | UPMC for Life Complete Care (HMO D-SNP)      | medicare_advantage | 23281                           | e-submit                                     | 180 d    |
| `independence_administrators`      | Independence Administrators (IBX TPA)        | commercial         | 54704                           | PO Box 21974, Eagan MN 55121                 | per plan |
| `surest_uhc`                       | Surest (a UnitedHealthcare plan)             | commercial         | **25463** (UHC-other = denied)  | PO Box 211758, Eagan MN 55121                | per plan |
| `progressive_auto`                 | Progressive (Auto PIP/MedPay)                | other (auto)       | 24260 (Availity) — notes        | adjuster (claim #)                           | policy   |
| `allstate_auto`                    | Allstate (Auto PIP/MedPay)                   | other (auto)       | C1037 (Jopari) — notes          | adjuster (claim #)                           | policy   |
| `nationwide_auto`                  | Nationwide (Auto PIP/MedPay)                 | other (auto)       | LV164 (Data Dimensions) — notes | adjuster (claim #)                           | policy   |
| `geico_auto`                       | GEICO (Auto PIP/MedPay)                      | other (auto)       | J1747 (Jopari) — notes          | adjuster (gen PO Box 9515 Fredericksburg VA) | policy   |
| `usaa_auto`                        | USAA (Auto PIP/MedPay)                       | other (auto)       | J1822 / 74095 (Jopari) — notes  | adjuster (AIS)                               | policy   |
| `guard_insurance_wc`               | Berkshire Hathaway GUARD (WC)                | workers_comp       | Jopari (id at enrollment)       | adjuster / GUARDCo                           | WC act   |
| `eastern_alliance_wc`              | Eastern Alliance (WC)                        | workers_comp       | J2143 (Jopari)                  | adjuster (PO Box 83777/14138 Lancaster)      | WC act   |
| `donegal_wc`                       | Donegal Insurance Group (WC)                 | workers_comp       | Jopari (id at enrollment)       | adjuster                                     | WC act   |
| `amerihealth_casualty_wc`          | AmeriHealth Casualty (WC)                    | workers_comp       | Jopari (id at enrollment)       | **PO Box 535370, Pittsburgh PA 15253**       | WC act   |
| `chubb_wc`                         | Chubb (WC; ESIS-administered)                | workers_comp       | J1554 (Jopari)                  | adjuster                                     | WC act   |
| `zurich_wc`                        | Zurich North America (WC)                    | workers_comp       | Jopari (id at enrollment)       | adjuster                                     | WC act   |
| `cna_wc`                           | CNA (WC)                                     | workers_comp       | Jopari (billing.cna.com)        | adjuster                                     | WC act   |

## Two caveats encoded in `notes` (read before billing)

- **Railroad Medicare (`railroad_medicare`, 00882) is Part B only.** CPAP
  (E0601), PAP supplies, and oxygen for a railroad beneficiary bill to the
  **DME MAC — Noridian Jurisdiction A** (the existing `medicare_dme_noridian`
  row), exactly as for regular Medicare. The `00882` row exists for Part B
  physician-jurisdiction services / crossover.
- **`pa_health_wellness_chc` is payer ID 68069.** The separate **AmeriHealth
  Caritas PA Community HealthChoices** (payer ID **77062**, PO Box 7110 London
  KY) is a different CHC-MCO — do not merge its id/address into this row.

## Modeling decisions

- **Community HealthChoices** is PA's Medicaid LTSS managed-care program — a
  DME-heavy population. The three statewide CHC plans bill under their parent's
  payer ID (UPMC 23281, Keystone First/AmeriHealth Caritas 42344, PHW/Centene
  68069). UPMC's CHC/Dual paper-claims box isn't separately published, so those
  rows submit electronically and leave the flat address NULL.
- **Federal DME programs** are fully addressed: CHAMPVA preauth applies only to
  DME ≥ $2,000 (CPAP usually below); TRICARE For Life pays the Medicare
  wraparound; the **federal Black Lung program** bills via the DOL OWCP portal
  (`owcpmed.dol.gov`) with a CM-893 CMN and NU/RR modifiers — it is paper /
  non-Office-Ally, like WC.
- **Auto no-fault / MedPay** (PA MVFRL, Act-6 fee cap) and **workers'-comp** are
  **claim-number / adjuster driven** and do **not** clear through Office Ally —
  they route through P&C/WC clearinghouses (Jopari, Data Dimensions, Carisk).
  So these rows are `paper_1500` / `paper_only=true` with the clearinghouse
  payer ID recorded **in `notes`**, no fixed claims PO box unless the carrier
  publishes one (AmeriHealth Casualty PO Box 535370; GEICO's general box noted
  as not-DME-specific). `requires_referring_provider_npi` is left false for
  these and for Black Lung.
- **Verified appeals addresses** were captured where published: Keystone First
  CHC (PO Box 80111, London KY) and Cigna Preferred Medicare (PO Box 188081,
  Chattanooga TN).

## Fields intentionally left NULL (verifiable per-row later, no deploy)

Exact paper-claims PO boxes for UPMC CHC/Dual and PA Health & Wellness CHC;
the Community Blue MA-specific payer ID variant; the Jopari payer IDs assigned
at enrollment for GUARD/Donegal/AmeriHealth Casualty/Zurich/CNA; member-ID
patterns; and CPAP-specific PA turnaround/fax where not printed on an official
document. None were guessed.

**Catalog total after 0210:** 82 + 25 = **107 payer profiles**.
