// Pure DME modifier-combination validation.
//
// Some HCPCS modifier combinations are mutually contradictory and cause
// a Medicare DME / commercial payer to reject the claim line as
// *unprocessable* — a hard rejection, not a coverage denial, so the line
// never adjudicates and the charge is simply lost until a corrected claim
// is filed. These are among the most common DME billing traps (see
// docs/dme-billing-software-and-office-ally-research-2026-06-09.md §1.2).
//
// This module is the single source of truth for "is this set of modifiers
// internally consistent?". It is pure (no I/O) so it can back both the
// claim preflight gate and any line editor that wants to warn inline, and
// is exhaustively unit-tested.
//
// The rules encoded here are the unambiguous hard contradictions only —
// payer-specific nuances (e.g. bilateral RT/LT two-line conventions) are
// intentionally NOT flagged here to keep the validator free of false
// positives.

/** Coverage / liability attestation modifiers. */
const KX = "KX"; // coverage criteria on file ARE met — expect payment
const GA = "GA"; // ABN on file; expect denial as not reasonable/necessary
const GZ = "GZ"; // expect denial, NO ABN on file (provider write-off)
const GY = "GY"; // statutorily excluded / not a Medicare benefit
const GX = "GX"; // voluntary notice of liability (pairs with GY only)

/** The "expect non-coverage / shift liability" family. */
const LIABILITY_FAMILY = new Set([GA, GZ, GY, GX]);
/** The three mutually-exclusive primary liability modifiers. */
const PRIMARY_LIABILITY = [GA, GZ, GY] as const;

/** Rental vs. purchase. */
const RR = "RR"; // rented
const NU = "NU"; // purchased new
const UE = "UE"; // purchased used

/** Capped-rental month-band modifiers — at most one per line. */
const CAPPED_RENTAL_MONTHS = ["KH", "KI", "KJ"] as const;

export type ModifierConflictCode =
  | "kx_with_liability"
  | "liability_modifier_exclusive"
  | "rental_with_purchase"
  | "purchase_new_used_exclusive"
  | "capped_rental_month_exclusive";

export interface ModifierConflict {
  /** Stable machine code so callers can branch / dedupe. */
  code: ModifierConflictCode;
  /** The specific offending modifiers, uppercased + de-duplicated. */
  modifiers: string[];
  /** One-line CSR-facing explanation of why the payer would reject. */
  message: string;
}

/**
 * Normalise a raw modifier list: uppercase, trim, keep only well-formed
 * 2-character tokens, de-dupe preserving first-seen order. Mirrors the
 * normalisation `resolveModifiersFromRules` and the ERA matcher use so a
 * line validated here matches what is actually emitted on the 837P.
 */
export function normalizeModifiers(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of raw) {
    const t = m.trim().toUpperCase();
    if (t.length === 2 && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Validate a single claim line's modifier set and return every hard
 * contradiction found (so the CSR sees all problems at once, not one at a
 * time). An empty array means the combination is internally consistent.
 *
 * Accepts either an array of modifiers or a comma-joined string (the shape
 * stored on `insurance_claim_line_items.modifier`).
 */
export function validateModifierCombination(
  raw: readonly string[] | string | null | undefined,
): ModifierConflict[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const mods = normalizeModifiers(list);
  const has = (m: string) => mods.includes(m);
  const conflicts: ModifierConflict[] = [];

  // R1 — KX (coverage criteria met) can never sit on the same line as a
  //      liability modifier (which asserts EXPECTED non-coverage). The
  //      payer rejects the line as unprocessable.
  if (has(KX)) {
    const liabilityPresent = mods.filter((m) => LIABILITY_FAMILY.has(m));
    if (liabilityPresent.length > 0) {
      conflicts.push({
        code: "kx_with_liability",
        modifiers: [KX, ...liabilityPresent],
        message: `KX asserts coverage criteria are met, but ${liabilityPresent.join(
          "/",
        )} asserts expected non-coverage — they are mutually exclusive and the payer will reject the line. Use one or the other.`,
      });
    }
  }

  // R2 — at most ONE primary liability modifier (GA/GZ/GY). You either
  //      have an ABN (GA), don't (GZ), or the item is statutorily
  //      excluded (GY); they cannot co-exist.
  const primaryPresent = PRIMARY_LIABILITY.filter((m) => has(m));
  if (primaryPresent.length > 1) {
    conflicts.push({
      code: "liability_modifier_exclusive",
      modifiers: [...primaryPresent],
      message: `Only one liability modifier is allowed per line; ${primaryPresent.join(
        "/",
      )} contradict each other (an ABN is either on file or it isn't).`,
    });
  }

  // R3 — rental (RR) and purchase (NU/UE) are mutually exclusive on a line.
  if (has(RR)) {
    const purchase = [NU, UE].filter((m) => has(m));
    if (purchase.length > 0) {
      conflicts.push({
        code: "rental_with_purchase",
        modifiers: [RR, ...purchase],
        message: `RR (rental) cannot appear with ${purchase.join(
          "/",
        )} (purchase) on the same line — a line is billed as rented or purchased, not both.`,
      });
    }
  }

  // R4 — new (NU) and used (UE) purchase are mutually exclusive.
  if (has(NU) && has(UE)) {
    conflicts.push({
      code: "purchase_new_used_exclusive",
      modifiers: [NU, UE],
      message:
        "NU (new) and UE (used) cannot both appear on a line — a purchased item is either new or used.",
    });
  }

  // R5 — capped-rental month band: at most one of KH/KI/KJ.
  const months = CAPPED_RENTAL_MONTHS.filter((m) => has(m));
  if (months.length > 1) {
    conflicts.push({
      code: "capped_rental_month_exclusive",
      modifiers: [...months],
      message: `A capped-rental line carries exactly one month-band modifier; ${months.join(
        "/",
      )} cannot co-exist (KH = month 1, KI = months 2-3, KJ = months 4-13).`,
    });
  }

  return conflicts;
}
