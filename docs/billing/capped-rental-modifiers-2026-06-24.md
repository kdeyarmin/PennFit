# Capped-rental modifier correctness — 2026-06-24

Context for DMEPOS sign-off + the Office Ally sandbox validation of 837P
output. Wrong rental-month modifiers are a hard denial, so this documents
exactly what the code emits and why.

## CMS capped-rental modifier sequence (authoritative)

Per the CMS DMEPOS LCDs / Noridian DME MAC capped-rental policy, a "month"
is a 30-day rental period:

| Rental month | Modifier | Meaning                                            |
| ------------ | -------- | -------------------------------------------------- |
| 1            | `KH`     | DMEPOS item, initial claim / first month rental    |
| 2–3          | `KI`     | DMEPOS item, second or third month rental          |
| 4–13         | `KJ`     | Capped rental, months four to thirteen             |
| any rental   | `RR`     | Rental — on every monthly bill                     |
| 4+, adherent | `KX`     | Coverage criteria met — only when 90-day adherence |
|              |          | is documented, for E0601 / E0470 / E0471           |

Source: Noridian "Capped Rental Items"
(https://med.noridianmedicare.com/web/jadme/topics/payment-categories/capped-rental).

The shared, tested `pickCappedRentalModifiers()`
(`lib/resupply-domain/src/capped-rental.ts`) implements exactly this.

## The bug this corrects

`payer_modifier_rules` was seeded (migration 0130) with a rotation that was
wrong **and** structurally inexpressible by the per-condition rule engine:

| Seeded (0130, WRONG)   | CMS-correct             |
| ---------------------- | ----------------------- |
| months 1–3 → `KH`      | month 1 → `KH`          |
| months 4+ → `KI`, `KX` | months 2–3 → `KI`       |
|                        | months 4–13 → `KJ`      |
|                        | `KX` only when adherent |

Two defects: (1) the single `if_rental_month_le_3` condition can't split
month 1 (`KH`) from months 2–3 (`KI`); (2) the 4+ row used `KI` where CMS
requires `KJ`, and applied `KX` unconditionally rather than gating it on
documented adherence (a one-condition rule can't express "month ≥ 4 **and**
compliant").

**Blast radius:** the capped-rental **auto-advance** worker already used the
correct `pickCappedRentalModifiers()` (writing the right modifiers onto
`insurance_claim_line_items.modifier`), so auto-advanced claims were never
wrong. Only **manually built** claims (`buildClaimFromFulfillment` →
`resolveModifiersFromRules`) consulted the bad seed.

## The fix

The wrong modifiers reached claims through **three** seeded surfaces; all are
now realigned on the shared `pickCappedRentalModifiers()`:

- **`claim-builder.ts`** (manual fulfillment-to-claim): derives the rotation
  from `pickCappedRentalModifiers()` via `cappedRentalRotationForLine`, and
  `mergeLineModifiers` strips any stale month-band/KX a copied commercial-payer
  rule or applied template still carries (so no conflicting `KJ`+`KI` pair).
  An initial dispense (no prior claims → `rentalMonth` null) is treated as
  month 1 so it still gets `RR`+`KH`.
- **`/admin/payer-modifier-rules/resolve`** (the manual-claim line editor's
  modifier prefill): merges the same rotation, so the prefill still surfaces
  `KH`/`KI`/`KJ` after the seed rows are gone.
- **Migration 0474** does two things, both guarded to the original wrong values
  so operator edits are preserved:
  1. drops the wrong `payer_modifier_rules` rotation rows from the Noridian
     seed;
  2. corrects the `claim_templates` row `rental_month_4_plus` from `RR,KI,KX`
     to `RR,KJ,KX` (the `rental_month_1` template was already correct at
     `RR,KH`).

`pickCappedRentalModifiers()` is the single source of truth; the auto-advance
worker already used it.

## Validation still required before go-live

- **DMEPOS sign-off** on the rotation table above.
- **Office Ally sandbox**: submit a capped-rental 837P at months 1, 2, 4 and
  confirm the SV1 modifiers and 999/277CA acceptance.

## Related decision (unchanged)

The G47.33 (OSA) diagnosis fallback in `office-ally-batch.ts` is **kept** —
OSA is the dominant correct diagnosis for CPAP supplies, so auto-stamping it
when no `diagnosis_icd10` is recorded is acceptable (operator decision,
2026-06-24).
