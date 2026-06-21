// decrementStockForPurchase — debit Stripe stock_count for purchased units.
//
// Stock_count (Stripe metadata) is the documented source of truth; it was
// checked at cart time but never moved on a sale. This helper debits it for
// the FRESHLY-inserted line items only (the once-only signal), clamps at 0,
// skips untracked SKUs, and is fail-soft per product.

import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";

import { decrementStockForPurchase } from "./checkout-session";

function fakeStripe(update = vi.fn().mockResolvedValue({})) {
  return {
    products: { update },
  } as unknown as Parameters<typeof decrementStockForPurchase>[0];
}

const noAccount: Stripe.RequestOptions = {};

describe("decrementStockForPurchase", () => {
  it("debits stock_count by the purchased quantity for tracked SKUs", async () => {
    const update = vi.fn().mockResolvedValue({});
    await decrementStockForPurchase(
      fakeStripe(update),
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

  it("aggregates quantity when a product spans multiple line rows", async () => {
    const update = vi.fn().mockResolvedValue({});
    await decrementStockForPurchase(
      fakeStripe(update),
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
    const update = vi.fn().mockResolvedValue({});
    await decrementStockForPurchase(
      fakeStripe(update),
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

  it("skips untracked SKUs (absent from the stock map)", async () => {
    const update = vi.fn().mockResolvedValue({});
    await decrementStockForPurchase(
      fakeStripe(update),
      noAccount,
      [{ product_id: "prod_untracked", quantity: 2 }],
      new Map([["prod_a", 5]]),
      undefined,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("does not write when stock is already 0 (no-op delta)", async () => {
    const update = vi.fn().mockResolvedValue({});
    await decrementStockForPurchase(
      fakeStripe(update),
      noAccount,
      [{ product_id: "prod_a", quantity: 2 }],
      new Map([["prod_a", 0]]),
      undefined,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("is fail-soft: a Stripe error on one SKU never throws", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("stripe down"))
      .mockResolvedValueOnce({});
    const warn = vi.fn();
    await expect(
      decrementStockForPurchase(
        fakeStripe(update),
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
    const update = vi.fn().mockResolvedValue({});
    await decrementStockForPurchase(
      fakeStripe(update),
      noAccount,
      [],
      new Map([["prod_a", 5]]),
      undefined,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
