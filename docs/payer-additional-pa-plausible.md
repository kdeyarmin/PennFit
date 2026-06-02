# Additional PA-plausible payers → payer_profiles map (migration 0209)

A second, broader wave on top of [`payer-top-25-national-pa.md`](./payer-top-25-national-pa.md).
Where `0208` added the top national plans **confirmed** sold in PA, `0209`
adds 25 more insurers/payers that a PA DME/CPAP supplier **may** encounter —
federal-employee (FEHB) plans, self-funded-employer TPAs, rental PPO networks,
additional Medigap, the PA Medicare HMO line of Health Partners, PA CHIP held
by the Blues, and workers'-comp / auto-no-fault casualty payers.

**Researched:** 2026-06 · **Bar:** "might be in PA" (national plans that touch
PA, federal plans whose members live here, regional TPAs that surface on stray
cards). Confidence is recorded per row; unverified fields are NULL, never
guessed.

## The 25 new rows

| Slug                              | Payer                                      | LOB          | EDI payer ID                    | Note                                              |
| --------------------------------- | ------------------------------------------ | ------------ | ------------------------------- | ------------------------------------------------- |
| `mhbp_fehb`                       | Mail Handlers Benefit Plan (FEHB)          | federal      | **UNVERIFIED** (Aetna network)  | ID left NULL until confirmed                      |
| `nalc_hbp_fehb`                   | NALC Health Benefit Plan (FEHB)            | federal      | 62308 (Cigna)                   | bills under Cigna                                 |
| `apwu_health_fehb`                | APWU Health Plan (FEHB)                    | federal      | 62308 (Cigna)                   | bills under Cigna                                 |
| `compass_rose_fehb`               | Compass Rose Health Plan (FEHB)            | federal      | 87726 (UHC)                     | bills under UnitedHealthcare                      |
| `samba_fehb`                      | SAMBA Health Benefit Plan (FEHB)           | federal      | 62308 (Cigna)                   | bills under Cigna                                 |
| `allied_benefit_systems`          | Allied Benefit Systems (TPA)               | commercial   | 37308                           | national self-funded TPA                          |
| `healthsmart_benefit_solutions`   | HealthSmart Benefit Solutions (TPA)        | commercial   | 87815 (+37272/UMR lines)        | confirm ID per card                               |
| `luminare_health`                 | Luminare Health (ex-Trustmark/CoreSource)  | commercial   | 35187                           | owned by HCSC                                     |
| `webtpa`                          | WebTPA (TPA)                               | commercial   | 75261                           | GuideWell family                                  |
| `imagine360`                      | Imagine360 (reference-based pricing)       | commercial   | 48143                           | HQ Wayne PA; RBP/open-access                      |
| `nova_healthcare_admin`           | Nova Healthcare Administrators (TPA)       | commercial   | 16644                           | WNY-regional; PA via employer cards               |
| `magnacare`                       | MagnaCare / Brighton Health Plan Solutions | commercial   | 11303                           | NY/NJ/CT network — borderline for PA              |
| `ebms`                            | EBMS (TPA)                                 | commercial   | 81039                           | national self-funded TPA                          |
| `first_health_network`            | First Health Network (rental PPO)          | commercial   | **router** (95019 only direct)  | bill the plan on the card                         |
| `multiplan_phcs`                  | MultiPlan / PHCS (rental PPO)              | commercial   | **router** (no own id)          | bill the plan on the card                         |
| `cigna_medsup`                    | Cigna Medicare Supplement (Medigap)        | other        | 13193                           | ≠ Cigna 62308; crossover, no PA                   |
| `aetna_medsup`                    | Aetna Medicare Supplement (Medigap)        | other        | 62118                           | ≠ Aetna 60054; crossover, no PA                   |
| `jefferson_health_plans_medicare` | Jefferson Health Plans Medicare (HPP HMO)  | MA           | 80142                           | Medicare sibling of `health_partners_pa_medicaid` |
| `upmc_for_kids_chip`              | UPMC for Kids (PA CHIP)                    | medicaid_mco | 23281 (UPMC)                    | PROMISe ID required                               |
| `ibx_chip`                        | Keystone Health Plan East CHIP (IBX)       | medicaid_mco | **by prefix** (id NULL)         | route via IBX grid; PROMISe ID required           |
| `highmark_chip`                   | Highmark Healthy Kids (PA CHIP)            | medicaid_mco | 54771 (Highmark; SB865 variant) | PROMISe ID required                               |
| `gallagher_bassett_wc`            | Gallagher Bassett (WC TPA)                 | workers_comp | **WC EDI** TP057 (notes only)   | not Office Ally                                   |
| `broadspire_wc`                   | Broadspire (WC TPA)                        | workers_comp | **WC EDI** E8088/Carisk (notes) | not Office Ally; TP021 retired                    |
| `esis_wc`                         | ESIS (WC TPA)                              | workers_comp | **UNVERIFIED** WC EDI           | not Office Ally                                   |
| `state_farm_auto`                 | State Farm (Auto MedPay / PIP)             | other        | **auto EDI** 31059 (notes only) | not Office Ally; DME after MVA                    |

## Modeling decisions (so future reviewers understand the NULLs)

- **FEHB plans bill under the parent network's payer ID.** NALC/APWU/SAMBA →
  Cigna `62308`; Compass Rose → UHC `87726`. They are marked `enrolled`
  because that clearinghouse connection already exists in the catalog. MHBP's
  electronic ID could not be confirmed, so it is **NULL + `pending`** rather
  than assuming `60054`.
- **Rental PPO networks are ROUTER rows** (`first_health_network`,
  `multiplan_phcs`) with no EDI ID and `edi_enrollment_status='not_applicable'`
  — exactly like the existing `anthem_bluecard` / `pa_chip` rows. You bill the
  plan/TPA on the member card; the network only reprices.
- **Workers'-comp / auto are a distinct EDI class.** Office Ally does not clear
  WC or auto; those route through Jopari / Data Dimensions / Carisk / P2P. So
  these rows are `paper_1500` / `paper_only=true` with the WC/auto payer ID
  recorded **in `notes` only** (Gallagher Bassett TP057, Broadspire **E8088**
  via Carisk — the old TP021 is retired, ESIS unverified, State Farm auto
  **31059**, _not_ the `31053` health line). DME is adjuster-authorized under
  the accepted claim, per PA WC / MVFRL rules — not a commercial PA workflow.
- **PA CHIP bills under each Blue's standard payer ID** and **requires a valid
  PA PROMISe provider ID** or the claim denies. Keystone Health Plan East CHIP
  routes by member-ID prefix (no single CHIP id), so its id is intentionally
  NULL with the routing rule in `notes`.
- **Medigap rows** (`cigna_medsup` 13193, `aetna_medsup` 62118) use payer IDs
  distinct from their commercial parents, require no prior auth, and pay as
  secondary via Medicare crossover.

## Deliberately excluded (not available in PA)

| Carrier         | Why excluded                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Zing Health** | Medicare Advantage only in IL / IN / MI / TN for 2026 — no Pennsylvania plan in any county. (Same posture as Molina/WellPoint in `0208`.) |

## Borderline rows (kept under the "might be in PA" bar — drop if undesired)

- **`magnacare`** — the MagnaCare network is NY/NJ/CT; only touches PA via
  out-of-area members on a Brighton-administered plan.
- **`nova_healthcare_admin`** — Western-NY regional TPA; in PA only via a PA
  employer/member carrying a Nova card.
- **`state_farm_auto`** — one representative auto no-fault carrier (DME after a
  motor-vehicle accident), following the existing `erie_insurance_pa` precedent.

All unverified payer IDs, claims addresses, timely-filing day counts, and fax
numbers are left NULL and can be filled per-row through the admin edit drawer
once confirmed — no deploy needed.
