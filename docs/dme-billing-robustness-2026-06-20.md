# DME billing robustness — current state & modifier-accuracy hardening (2026-06-20)

**Audience:** Penn Home Medical Supply / CareMetric Breathe ownership + engineering.
**Method:** Code-verified read of the billing stack (EDI builders/parsers in
`lib/resupply-integrations-office-ally`, the `lib/billing/*` engine, the
`/admin/billing/*` routes + SPA, and the `insurance_claims` schema), then a
narrow, well-scoped hardening change. Supersedes the gap lists in
[`feature-gaps-analysis-2026-06-14.md`](./feature-gaps-analysis-2026-06-14.md)
and
[`dme-billing-software-and-office-ally-research-2026-06-09.md`](./dme-billing-software-and-office-ally-research-2026-06-09.md)
where they are now stale.

---

## TL;DR

1. **PennFit is already a best-in-class DME billing system.** It ships the full
   X12 5010 revenue cycle — 837P, 270/271, 276/277, 277CA, 835/ERA, 999 — plus
   AI claim scrubbing + denial prediction, capped-rental modifier rotation with
   live 4/70 compliance gating, Da Vinci PAS prior-auth, payer/fee-schedule/
   modifier-rule catalogs, and patient collections (statements, autopay, plans).
   On the dimensions that move cash it meets or exceeds Brightree / Bonafide /
   NikoHealth / WellSky.

2. **The prior gap docs are now stale on their headline items** — both have
   been built since they were written:
   - _"Auto-draft secondary/COB on primary 835 post" (the 06-14 doc's only
     "genuinely worthwhile new build")_ → **shipped.** `auto-workflow-engine.ts`
     Pass 4 (`runSecondaryClaimPass`) drafts the secondary behind the seeded
     `billing.auto_secondary_claims` flag (migrations 0324/0328), reusing the
     shared `secondary-claim-generator`.
   - _"Itemize patient responsibility (copay/coinsurance/deductible) from ERA
     CAS segments" (06-14 P2)_ → **shipped.** `era-reconciler.ts`
     `patientRespBreakdown()` buckets CARC 1/2/3 from the PR-group CAS at both
     claim and line level onto `deductible_cents` / `coinsurance_cents` /
     `copay_cents`.

3. **This change closes the two remaining modifier-accuracy gaps** — both are
   among the DME denial traps the 06-09 research itself enumerated (§1.2), and
   both were still open in code:
   - **Invalid modifier-combination validation** (new) — blocks the hard-reject
     combinations (`KX` with `GA`/`GZ`/`GY`/`GX`, two liability modifiers,
     rental + purchase, new + used, two capped-rental month bands) at preflight
     before they reach the payer.
   - **ABN-on-file wired into the modifier engine** — the `if_abn_on_file`
     payer-rule condition was hardcoded `false` ("not modelled today") even
     though signed ABNs are captured in `patient_form_acknowledgements`. It now
     reads that data, so an `if_abn_on_file → GA` rule actually fires.

---

## Part 1 — What this change adds

### 1.1 Invalid modifier-combination validator (prevents hard rejections)

Certain HCPCS modifier pairs reject the claim **line** as _unprocessable_ (a
front-end/clearinghouse reject, not a coverage denial) — the line never
adjudicates and the charge is simply lost until a corrected claim is filed. The
canonical DME example (06-09 §1.2 trap #3): **`KX` (coverage criteria met)
must never sit on the same line as `GA`/`GZ`/`GY`/`GX` (expected
non-coverage)** — they are contradictory.

New pure module **`artifacts/resupply-api/src/lib/billing/modifier-validation.ts`**
— `validateModifierCombination(modifiers)` returns every contradiction found:

| Code                            | Rule                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `kx_with_liability`             | `KX` together with any of `GA`/`GZ`/`GY`/`GX`              |
| `liability_modifier_exclusive`  | more than one of the primary liability mods `GA`/`GZ`/`GY` |
| `rental_with_purchase`          | `RR` together with `NU` or `UE`                            |
| `purchase_new_used_exclusive`   | `NU` together with `UE`                                    |
| `capped_rental_month_exclusive` | more than one of `KH`/`KI`/`KJ`                            |

It is deliberately limited to **unambiguous hard contradictions** so it never
false-positives (e.g. the valid voluntary-notice `GX`+`GY` pairing passes;
payer-specific bilateral `RT`/`LT` two-line conventions are intentionally not
flagged here). Fully unit-tested in `modifier-validation.test.ts` (21 cases).

**Wired into the submit gate:** `claim-preflight.ts` runs it per line and emits
an `error`-severity `modifier_combination` item (with an `edit_line_item`
fix-action) — so a contradictory line **blocks submit** the same way the
NOC-narrative and bill-hold checks do, and a corrected line goes out the first
time instead of bouncing.

### 1.2 ABN-on-file → modifier engine (`if_abn_on_file` activated)

A signed Advance Beneficiary Notice (CMS-R-131) determines liability on an
expected-non-coverage line: with an ABN on file you bill **`GA`** and the
**patient** is liable; without one you bill `GZ` and the supplier must write it
off. PennFit already captures signed ABNs in
`patient_form_acknowledgements` (`form_kind='abn'`, migration 0106; the Option
1/2/3 choice in 0315) and already defines the `if_abn_on_file` payer-rule
condition (migration 0130) — but the rule engine hardcoded that condition to
`false`, so the rule could never fire.

This change:

- adds `isAbnOnFile` to `ModifierRuleContext` and makes
  `ruleApplies("if_abn_on_file", ctx)` return it (`modifier-rules.ts`);
- resolves it in `claim-builder.ts` from a signed ABN acknowledgement for the
  patient (lookup error → `false`, so bad data never silently shifts liability
  to the patient);
- exposes it as `abnOnFile` on the manual modifier-preview endpoint
  (`/admin/payer-modifier-rules/resolve`).

**Behaviour-safe:** no seeded `payer_modifier_rules` row uses `if_abn_on_file`
today, so this is **latent capability** — it changes zero existing claim output
until an operator configures such a rule. And when they do, the new validator
guarantees the resulting `GA` can never silently collide with a `KX` rule on
the same line.

**No migration.** Everything above is code/types/tests against existing tables
and the existing condition enum.

---

## Part 2 — Genuinely open items (verified, prioritized)

After this change, the short list of things that are _actually not built_ and
would further harden DME billing:

| #   | Item                                                                                                      | Type    | Notes                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~**HCPCS↔diagnosis (LCD) medical-necessity edits**~~ — **DONE** (see _LCD medical-necessity edit_ below) | Build   | Shipped: `hcpcs_coverage_diagnoses` catalog (mig 0408) + `coverage-diagnosis.ts` evaluator + preflight warning.                                     |
| 2   | ~~**Bilateral `RT`/`LT` two-line convention**~~ — **DONE**                                                | Build   | Shipped: `findModifierAdvisories()` in `modifier-validation.ts` + a non-blocking `bilateral_modifier` preflight warning when RT+LT sit on one line. |
| 3   | ~~**CMS DMEPOS fee-schedule auto-import**~~ — **DONE**                                                    | Build   | Shipped: `cms-dmepos-fee-schedule.ts` parser (header-driven grid) + `POST /admin/payer-fee-schedules/import-cms` → `payer_fee_schedules`.           |
| 3b  | ~~**Per-payer coverage overrides**~~ — **DONE**                                                           | Build   | Shipped: `payer_profile_id` on `hcpcs_coverage_diagnoses` (mig 0415) + evaluator override resolution + `/admin/payer-coverage-diagnoses` CRUD.      |
| 4   | **ABN scoping** — the ABN acknowledgement is patient-level, not per-HCPCS/per-episode                     | Build   | Today "ABN on file" = any signed ABN for the patient. A per-item ABN record would let `GA` attach only to the covered line.                         |
| 4b  | **Admin SPA pages** for the per-payer coverage overrides + CMS fee import                                 | Build   | Backend (API + parser) shipped; a config UI mirroring the payer fee-schedule/modifier-rule pages is the remaining follow-on.                        |
| 5   | **Same-or-Similar automation (HETS)** — currently a manual entry                                          | Ops     | Needs a CMS HETS connection; the route + manual workflow already exist.                                                                             |
| 6   | **Live therapy-cloud data (ResMed/Philips/3B)** — adapters are production-ready                           | Bus-dev | Gated on executed partner BAAs/OAuth, not on code.                                                                                                  |
| 7   | **Multi-location / multi-tenant billing identity**                                                        | Build   | Schema is forward-compatible (mig 0132); defer until a concrete second-location/resale trigger.                                                     |

### Bottom line

The billing engine was already comprehensive; the highest-leverage remaining
work is **accuracy hardening at the line level**, and the most common modifier
traps (KX/liability contradictions and ABN-driven `GA`) plus the LCD
medical-necessity edit (Part 3) are now closed. The rest of the open list is
either a smaller follow-on (item 2, ABN scoping item 4) or
business-development/ops (items 5–6), not a quick code win.

---

## Part 3 — LCD medical-necessity edit (HCPCS ↔ diagnosis)

Closes open item #1 above. The preflight already verified a diagnosis was
_present_ (the latest sleep study's ICD-10); it now also verifies the diagnosis
**supports** each billed HCPCS under the payer's coverage policy. A PAP claim
whose diagnosis isn't a covered indication denies for medical necessity — one
of the recurring DME denial traps.

- **`hcpcs_coverage_diagnoses` catalog** (migration 0408; extended by 0409) — a
  GLOBAL reference table (like `hcpcs_codes`/`denial_codes`, no `org_id`,
  deny-all RLS) mapping a billable HCPCS to the ICD-10 codes that support it.
  Seeded with two CMS policies:
  - **PAP / OSA — LCD L33718** (Article A52467): obstructive sleep apnea
    **G47.33** for E0601 (CPAP), E0470 (bilevel without backup), and the
    resupply accessories billed against them.
  - **RAD — LCD L33800** (Article A52517): all four non-OSA respiratory
    indications for E0470 and E0471 — central/complex sleep apnea
    (G47.31/G47.37), hypoventilation incl. OHS (G47.34/35/36, E66.2), severe
    COPD (J44.x), and restrictive thoracic disorders (neuromuscular families
    G12/G35/G70/G71/… and thoracic-cage kyphosis/scoliosis M40.0-2/M41 +
    congenital Q67/Q76 leaves). **E0471 (bilevel-ST, backup rate) is
    deliberately NOT given G47.33** — OSA doesn't justify a backup-rate device,
    so an E0471 + primary-OSA claim still warns; E0470 is dual-policy (OSA under
    L33718 + RAD under L33800).

  **Caveat (documented in the migration):** A52517 publishes **no enumerated
  ICD-10 "covered codes" table** for RAD — it is a narrative, criteria-driven
  policy (qualifying diagnosis **+** a physiologic test). So the RAD rows are a
  **clinical crosswalk of screening signals** (necessary-but-not-sufficient),
  sized to keep a genuine RAD claim from false-warning; they are not a CMS
  allow-list and the physiologic gates live in the documentation. Family roots
  are used only where every leaf qualifies (e.g. `G71`); mixed families use
  specific leaves so a prefix can't over-claim (kyphosis `M40.0/1/2` not
  lordosis; diaphragm leaf `J98.6` not all of `J98`). **Per-payer commercial
  overrides** remain a documented follow-on.

- **`coverage-diagnosis.ts`** — a pure, unit-tested evaluator that normalises
  ICD-10 codes (dotless, uppercase) and matches a claim diagnosis to a covered
  code by **prefix** (a category code covers its children; a covered specific
  code is not satisfied by a vaguer one).
- **Preflight wiring** — for each billed HCPCS that has catalogued rules, a
  diagnosis that doesn't support it surfaces a **non-blocking warning**
  (`medical_necessity_dx`) citing the policy. Deliberately a warning, not a hard
  error: the catalog is a baseline and the single sleep-study code we read may
  not be the claim's full diagnosis picture. **Fail-soft:** a HCPCS with no
  catalogued rules yields no opinion (never a false-positive), and a catalog
  read error is swallowed (the check is skipped, never 500s the preflight).

Validated by a fresh full migration replay (400 migrations) + idempotent re-run,
the `coverage-diagnosis` unit tests, and two `preflightClaim` integration tests
(an unsupported diagnosis warns without blocking; a covered one is silent).
