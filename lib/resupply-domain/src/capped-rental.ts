// Medicare capped-rental lifecycle — pure decision + modifier rotation
// (ADR 008: no I/O, no Date.now() except a passed-in clock).
//
// What Medicare requires
// ----------------------
// Capped-rental DME (e.g. a PAP device) is rented monthly, not purchased.
// Each rental month is billed with a HCPCS modifier ROTATION, and after
// the cap the equipment converts to patient ownership:
//
//   * RR — "rental" — on EVERY month.
//   * KH — first rental month of a capped-rental item — months 1-3.
//   * KI — second/third rental month — months 4-13.
//   * KX — "requirements specified in the medical policy have been met" —
//     added in months 4-13 only when the patient is compliant AND the
//     HCPCS is one of the PAP/RAD codes that gate KX on adherence.
//
// A new month is "due" on each 30-day anniversary of the cycle start;
// once the cycle reaches its `maxMonths` cap the device transfers to the
// beneficiary.
//
// Why this lives in @workspace/resupply-domain
// --------------------------------------------
// A wrong modifier is a hard denial. The rotation set and the month bands
// were magic constants buried in the daily worker; hoisting them (and the
// due/transfer decision) here gives the worker, the CSR override route,
// and a claim-preview UI one tested source of truth. The DB writes (the
// atomic month-claim, the draft-claim insert) stay in the worker.

/** HCPCS codes whose KX modifier is gated on documented adherence. */
export const CAPPED_RENTAL_KX_HCPCS = ["E0601", "E0470", "E0471"] as const;

/** Days between capped-rental anniversaries (one rental month). */
export const CAPPED_RENTAL_CYCLE_DAYS = 30;

const KX_HCPCS_SET = new Set<string>(CAPPED_RENTAL_KX_HCPCS);

/**
 * The HCPCS modifier codes for a given capped-rental month, following the CMS
 * capped-rental modifier sequence:
 *
 *   - "RR" — rental — on EVERY month.
 *   - "KH" — first rental month (month 1).
 *   - "KI" — second and third rental month (months 2-3).
 *   - "KJ" — capped-rental / PEN-pump continuation, months 4 onward (through
 *     the cycle's full length, so no continuation claim goes out with a bare
 *     "RR"). "KX" ("medical-policy criteria met") rides on the KJ months when
 *     `isCompliant` is true and `hcpcs` is one of the adherence-gated codes.
 *
 * Previously this emitted KH for months 1-3, KI for months 4-13, and only
 * "RR" past month 13 — a non-standard mapping that left long (oxygen-length)
 * cycles sending continuation claims with no rental-month modifier, which
 * payers deny.
 */
export function pickCappedRentalModifiers(
  hcpcs: string,
  month: number,
  isCompliant: boolean,
): string[] {
  const mods: string[] = ["RR"];
  if (month <= 1) {
    mods.push("KH");
  } else if (month <= 3) {
    mods.push("KI");
  } else {
    mods.push("KJ");
    if (isCompliant && KX_HCPCS_SET.has(hcpcs)) mods.push("KX");
  }
  return mods;
}

export type CappedRentalAction = "noop" | "advance" | "transfer";

export interface CappedRentalAdvanceInput {
  /** Cycle start date (YYYY-MM-DD). */
  startDate: string;
  /** The cycle's current rental month — the persisted
   *  `capped_rental_cycles.current_month` value: the number of rental
   *  months already represented on the cycle (1 after the initial month,
   *  advanced to 2, 3, …). NOT 0-based. The next claim is for
   *  `currentMonth + 1`. */
  currentMonth: number;
  /** Cap after which the device converts to patient ownership. */
  maxMonths: number;
  /** "Now" for the due check. Defaults to the current instant. */
  asOf?: Date;
}

export interface CappedRentalAdvanceDecision {
  action: CappedRentalAction;
  /** The month the cycle would advance TO (currentMonth + 1) on an
   *  "advance"; equal to currentMonth otherwise. */
  nextMonth: number;
  /** The anniversary instant for the next month, in epoch ms — the
   *  date-of-service the worker stamps on the generated claim. */
  nextDueMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether a capped-rental cycle should advance a month, transfer
 * ownership, or do nothing, as of `asOf`. Pure mirror of the worker's
 * original inline logic: the anniversary is `start + currentMonth × 30d`;
 * not yet reached → noop; reached at/after the cap → transfer; otherwise
 * advance one month.
 */
export function decideCappedRentalAdvance(
  input: CappedRentalAdvanceInput,
): CappedRentalAdvanceDecision {
  const asOfMs = (input.asOf ?? new Date()).getTime();
  const start = new Date(`${input.startDate}T00:00:00Z`).getTime();
  // A corrupt / unparseable startDate makes `start` (and therefore
  // `nextDueMs`) NaN. `asOfMs < NaN` is false, so without this guard the
  // function would skip `noop` and fall through to advance/transfer purely
  // on the month count — silently moving a capped-rental cycle forward (or
  // transferring ownership) with no valid anniversary. Never advance billing
  // on an un-anchorable date; treat it as "not yet due".
  if (!Number.isFinite(start)) {
    return { action: "noop", nextMonth: input.currentMonth, nextDueMs: asOfMs };
  }
  const nextDueMs =
    start + input.currentMonth * CAPPED_RENTAL_CYCLE_DAYS * DAY_MS;

  if (asOfMs < nextDueMs) {
    return { action: "noop", nextMonth: input.currentMonth, nextDueMs };
  }
  if (input.currentMonth >= input.maxMonths) {
    return { action: "transfer", nextMonth: input.currentMonth, nextDueMs };
  }
  return { action: "advance", nextMonth: input.currentMonth + 1, nextDueMs };
}
