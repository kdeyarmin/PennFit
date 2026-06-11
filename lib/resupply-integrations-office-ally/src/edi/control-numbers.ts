// Control-number management for X12 envelopes.
//
// The 5010 spec requires that ISA13 (interchange control number),
// GS06 (group control number), and ST02 (transaction set control
// number) all be strictly monotonic per trading-partner relationship.
// Office Ally enforces this — a re-used ISA13 in the same window is
// rejected at the 999 stage.
//
// We derive each number deterministically from `submittedAt` (UTC ms)
// plus a row-local sequence so concurrent submissions in the same
// second never collide. The persistence layer (the API route) is
// responsible for guaranteeing the input is monotonic by reading the
// MAX ISA13 from `resupply.office_ally_submissions` inside a
// transaction; this helper just formats.

import type { ControlNumbers } from "./837p";

export interface AllocateControlNumbersInput {
  /** UTC ms timestamp. The caller passes the submission's `submitted_at`. */
  submittedAt: number;
  /** 1-based sequence within the second. Defaults to 1. */
  sequence?: number;
  /** Previously-seen highest ISA13 (zero-padded numeric string). The
   *  allocator returns at least previousHigh + 1 to guarantee monotonicity. */
  previousHighest?: string;
}

/**
 * Allocate fresh control numbers for a single 837P submission.
 *
 * ISA13 (9-digit) is derived from a base counter that combines the
 * UTC time and the in-second sequence, so values are visually
 * recognisable (later submissions sort higher lexicographically) and
 * still strictly monotonic across reasonable submission rates.
 *
 * GS06 (1-9 digit) uses the same numeric value with leading zeros
 * stripped.
 *
 * ST02 (4-9 digit, padded to 4 with leading zeros for readability)
 * also reuses the base counter modulo 100000 — there's only ever one
 * ST per submission for us, so collision risk is structural-only.
 */
/**
 * Format a PRE-RESERVED ISA13 value into the full control-number set.
 * Used by the atomic counter-table allocation path
 * (resupply.control_number_counters, migration 0307): the caller has
 * already CAS-reserved a unique value, so no previousHighest guard is
 * needed — formatting is the only job left. Wraps into the 9-digit
 * field exactly like allocateControlNumbers.
 */
export function controlNumbersFromValue(
  isaValue: number,
  submittedAt: number,
): ControlNumbers {
  const MOD = 1_000_000_000;
  const isa = ((isaValue % MOD) + MOD) % MOD;
  const isaStr = String(isa).padStart(9, "0");
  return {
    interchangeControlNumber: isaStr,
    groupControlNumber: String(isa),
    transactionSetControlNumber: String(isa % 100000).padStart(4, "0"),
    builtAt: submittedAt,
  };
}

export function allocateControlNumbers(
  input: AllocateControlNumbersInput,
): ControlNumbers {
  const sequence = input.sequence ?? 1;
  // The numeric base is (seconds-since-2025) * 10 + (sequence % 10).
  // 2025-01-01T00:00:00Z = 1735689600 — we subtract that to keep the
  // value small.
  //
  // CAUTION: this base crosses 1_000_000_000 at ~(1e8 seconds) ≈ 3.17
  // years past the epoch, i.e. around 2028-03, NOT "past 2050". After
  // that point `base % MOD` wraps, and the `* 10 + sequence%10` term caps
  // the time-derived value at 10 distinct slots/second. Correctness does
  // NOT depend on the time-derived value being unique or strictly
  // increasing: the `previousHighest` guard below (MAX ISA13 read from the
  // DB by the persistence layer) is what guarantees strict monotonicity —
  // after the 2028 wrap, allocation simply continues as previousHigh + 1.
  // The only property lost at the wrap is the cosmetic "later submission
  // sorts higher by its time-derived digits."
  const epochSecs2025 = 1735689600;
  const nowSecs = Math.floor(input.submittedAt / 1000);
  const base = Math.max(0, (nowSecs - epochSecs2025) * 10 + (sequence % 10));
  // ISA13 is a 9-digit fixed-width field; the maximum value is
  // 999_999_999 and we MUST wrap back to 0 once we exhaust it. Office
  // Ally accepts a wrap once the receiver has acked all prior batches.
  const MOD = 1_000_000_000;
  let isa = base % MOD;
  if (input.previousHighest) {
    const prev = Number.parseInt(input.previousHighest.replace(/^0+/, ""), 10);
    if (Number.isFinite(prev) && prev >= isa) {
      isa = (prev + 1) % MOD;
    }
  }
  const isaStr = String(isa).padStart(9, "0");
  const gs = String(isa);
  const st = String(isa % 100000).padStart(4, "0");
  return {
    interchangeControlNumber: isaStr,
    groupControlNumber: gs,
    transactionSetControlNumber: st,
    builtAt: input.submittedAt,
  };
}
