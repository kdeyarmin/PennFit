// decrementStockForPurchase — debit Stripe stock_count for purchased units.
//
// Stock_count (Stripe metadata) is the documented source of truth; it was
// checked at cart time but never moved on a sale. This helper debits it for
// the FRESHLY-inserted line items only (the once-only signal), re-reads the
// CURRENT stock immediately before the write (so a concurrent debit isn't
// overwritten from a stale snapshot), clamps at 0, skips untracked SKUs, and
// is fail-soft per product.

import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";

import { decrementStockForPurchase } from "./checkout-session";

// Build a fake Stripe whose products.retrieve returns the CURRENT stock for a
// product id, and whose products.update records the write. `current` maps
// productId -> stock_count value to report on retrieve (null/undefined => the
// product is no longer stock-tracked).
function fakeStripe(
  current: Record<string, number | null>,
  update = vi.fn().mockResolvedValue({}),
  retrieve = vi.fn(async (id: string) => ({
    id,
    metadata:
      current[id] === null || current[id] === undefined
        ? {}
        : { stock_count: String(current[id]) },
  })),
) {
  return {
    stripe: {
      products: { retrieve, update },
    } as unknown as Parameters<typeof decrementStockForPurchase>[0],
    update,
    retrieve,
  };
}

const noAccount: Stripe.RequestOptions = {};

describe("decrementStockForPurchase", () => {
  it("debits stock_count by the purchased quantity for tracked SKUs", async () => {
    const { stripe, update } = fakeStripe({ prod_a: 5 });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [{ product_id: "prod_a", quantity: 2 }],
      new Map([["prod_a", 5]]),
      undefined,
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      "prod_a",
      { metadata: { stock_count: "3" } },
      noAccount,
    );
  });

  it("decrements from the FRESH re-read, not the stale checkout snapshot", async () => {
    // Snapshot at checkout said 5, but a concurrent order already dropped it
    // to 4 by the time this webhook runs — we must debit from 4, not 5.
    const { stripe, update } = fakeStripe({ prod_a: 4 });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [{ product_id: "prod_a", quantity: 1 }],
      new Map([["prod_a", 5]]),
      undefined,
    );
    expect(update).toHaveBeenCalledWith(
      "prod_a",
      { metadata: { stock_count: "3" } },
      noAccount,
    );
  });

  it("aggregates quantity when a product spans multiple line rows", async () => {
    const { stripe, update } = fakeStripe({ prod_a: 10 });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [
        { product_id: "prod_a", quantity: 2 },
        { product_id: "prod_a", quantity: 1 },
      ],
      new Map([["prod_a", 10]]),
      undefined,
    );
    expect(update).toHaveBeenCalledWith(
      "prod_a",
      { metadata: { stock_count: "7" } },
      noAccount,
    );
  });

  it("clamps at 0 (never negative) when quantity exceeds stock", async () => {
    const { stripe, update } = fakeStripe({ prod_a: 3 });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [{ product_id: "prod_a", quantity: 9 }],
      new Map([["prod_a", 3]]),
      undefined,
    );
    expect(update).toHaveBeenCalledWith(
      "prod_a",
      { metadata: { stock_count: "0" } },
      noAccount,
    );
  });

  it("skips untracked SKUs (absent from the stock map) without a Stripe call", async () => {
    const { stripe, update, retrieve } = fakeStripe({ prod_a: 5 });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [{ product_id: "prod_untracked", quantity: 2 }],
      new Map([["prod_a", 5]]),
      undefined,
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("does not write when the fresh stock is already 0 (no-op delta)", async () => {
    const { stripe, update } = fakeStripe({ prod_a: 0 });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [{ product_id: "prod_a", quantity: 2 }],
      new Map([["prod_a", 1]]),
      undefined,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("skips when the product is no longer stock-tracked at write time", async () => {
    const { stripe, update } = fakeStripe({ prod_a: null });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [{ product_id: "prod_a", quantity: 2 }],
      new Map([["prod_a", 5]]),
      undefined,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("is fail-soft: a Stripe error on one SKU never throws", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("stripe down"))
      .mockResolvedValueOnce({});
    const { stripe } = fakeStripe({ prod_a: 5, prod_b: 5 }, update);
    const warn = vi.fn();
    await expect(
      decrementStockForPurchase(
        stripe,
        noAccount,
        [
          { product_id: "prod_a", quantity: 1 },
          { product_id: "prod_b", quantity: 1 },
        ],
        new Map([
          ["prod_a", 5],
          ["prod_b", 5],
        ]),
        { warn },
      ),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no-ops when nothing was freshly inserted (idempotent re-delivery)", async () => {
    const { stripe, update, retrieve } = fakeStripe({ prod_a: 5 });
    await decrementStockForPurchase(
      stripe,
      noAccount,
      [],
      new Map([["prod_a", 5]]),
      undefined,
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
