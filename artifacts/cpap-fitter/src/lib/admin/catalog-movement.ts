// Turning what an operator typed into a stock movement.
//
// The catalog page never lets anyone set on-hand directly — you say what
// happened and the server derives the balance, which is what keeps the
// ledger and the count in agreement. That makes this conversion the one
// piece of real logic on the page, so it lives here as a pure function
// rather than inside a mutation callback where it can only be tested by
// reading the source.

import type { StockReason } from "./catalog-api";

/** Reasons whose quantity ADDS to on-hand. Everything else subtracts. */
const INBOUND: readonly StockReason[] = ["receipt", "return"];

export class InvalidMovementError extends Error {}

/**
 * Convert an operator's entry into a signed delta.
 *
 * `amount` means different things per reason, and conflating them is the
 * easy bug: for a physical `count` it is the ABSOLUTE total the operator
 * counted on the shelf, so the delta is whatever moves the book to that
 * number (and may be negative). For every other reason it is a QUANTITY
 * that moved, and the sign comes from the reason.
 *
 * Throws {@link InvalidMovementError} for input the server would reject
 * anyway — a non-integer, a non-positive quantity, or a count that
 * matches what we already believe (a zero delta is not a movement, and
 * the RPC refuses it).
 *
 * @param currentStock on-hand before the movement; `null` when the SKU is
 *   untracked, which is treated as 0 for a count so the first count
 *   establishes the balance.
 */
export function movementDelta(
  reason: StockReason,
  amount: number,
  currentStock: number | null,
): number {
  if (!Number.isInteger(amount)) {
    throw new InvalidMovementError("Enter a whole number.");
  }
  if (reason === "count") {
    if (amount < 0) {
      throw new InvalidMovementError("A count can't be negative.");
    }
    const delta = amount - (currentStock ?? 0);
    if (delta === 0) {
      throw new InvalidMovementError(
        "That count matches the current number — nothing to record.",
      );
    }
    return delta;
  }
  if (amount <= 0) {
    throw new InvalidMovementError("Enter a whole number greater than zero.");
  }
  return INBOUND.includes(reason) ? amount : -amount;
}
