// Stock decrement when a resupply fulfillment is committed to a patient.
//
// WHERE this fires, and why it isn't "on ship":
//   PacWare is the warehouse/billing system of record — it is a CSV file
//   exchange with no API, so nothing in this app ever flips a fulfillment
//   to shipped. The only lifecycle transition the app genuinely owns is
//   QUEUED: the moment a unit is committed to a named patient. Decrementing
//   there is also the conservative read for a warehouse — you stop
//   promising stock you don't have, rather than discovering it at pick time.
//
// FAIL-SOFT, always:
//   A resupply order must never fail because the catalog is incomplete. A
//   SKU nobody has registered yet, or a count that would go negative, is a
//   bookkeeping problem for a CSR to reconcile — not a reason to withhold
//   supplies a patient is due. Every path here logs and returns; none throw.
//
// The counterpart is `reason: 'return'`, applied by hand from the catalog
// page when a unit comes back.

import { InsufficientStockError, UnknownSkuError, adjustStock } from "./store";
import { logger } from "../logger";

export interface DispenseRecordInput {
  orgId: string;
  /** The SKU actually going out (post-substitution). */
  sku: string;
  /** Units leaving the shelf. Must be positive. */
  quantity: number;
  /** Fulfillment id, so the ledger row points back at what caused it. */
  fulfillmentId: string;
}

/**
 * Record a dispense against on-hand stock. Never throws — the caller has
 * already committed the fulfillment and must not be rolled back by a
 * catalog miss.
 *
 * Returns the new balance, `null` when the SKU is untracked, or `undefined`
 * when nothing was recorded (unknown SKU / insufficient stock / error).
 */
export async function recordDispense(
  input: DispenseRecordInput,
): Promise<number | null | undefined> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    logger.warn(
      { event: "catalog.dispense.bad_quantity", sku: input.sku },
      "catalog: refusing a non-positive dispense quantity",
    );
    return undefined;
  }

  try {
    return await adjustStock(
      input.orgId,
      {
        sku: input.sku,
        delta: -input.quantity,
        reason: "dispense",
        reference: input.fulfillmentId,
      },
      null,
    );
  } catch (err) {
    if (err instanceof UnknownSkuError) {
      // Expected during rollout: the tenant is dispensing a SKU they
      // haven't catalogued. Info, not warn — it is not a fault.
      logger.info(
        { event: "catalog.dispense.uncatalogued_sku", sku: input.sku },
        "catalog: dispensed a SKU that is not in the catalog — not counted",
      );
      return undefined;
    }
    if (err instanceof InsufficientStockError) {
      // The shelf disagrees with the book. The order still goes out; the
      // count needs a physical reconcile.
      logger.warn(
        { event: "catalog.dispense.insufficient_stock", sku: input.sku },
        "catalog: dispense exceeds recorded on-hand — count needs reconciling",
      );
      return undefined;
    }
    logger.warn(
      { event: "catalog.dispense.failed", sku: input.sku, err },
      "catalog: stock decrement failed (non-fatal)",
    );
    return undefined;
  }
}
