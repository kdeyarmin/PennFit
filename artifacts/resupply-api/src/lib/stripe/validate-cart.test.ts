// validate-cart request-options forwarding (Stripe Connect, G6).
//
// The checkout routes create the session on the tenant's connected account;
// validateCartItems MUST read prices from the SAME account, or every line is
// rejected as price_not_found. These tests lock the threading of
// `requestOptions` through to prices.retrieve / prices.list.

import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { validateCartItems } from "./validate-cart";

const PRODUCT = {
  active: true,
  deleted: false,
  metadata: { category: "mask" },
  default_price: {
    id: "price_1",
    active: true,
    type: "one_time",
    unit_amount: 1000,
  },
} as unknown as Stripe.Product;

function makeStripe(opts: { retrieve: unknown; list?: { data: unknown[] } }) {
  const retrieve = vi.fn(async () => opts.retrieve);
  const list = vi.fn(async () => opts.list ?? { data: [] });
  const stripe = { prices: { retrieve, list } } as unknown as Stripe;
  return { stripe, retrieve, list };
}

describe("validateCartItems — Connect request options", () => {
  it("forwards requestOptions to prices.retrieve for a one-time line", async () => {
    const { stripe, retrieve } = makeStripe({
      retrieve: {
        id: "price_1",
        active: true,
        type: "one_time",
        unit_amount: 1000,
        product: PRODUCT,
      },
    });
    const ro = { stripeAccount: "acct_x" } as Stripe.RequestOptions;
    const res = await validateCartItems(
      stripe,
      [{ priceId: "price_1", quantity: 1, mode: "one_time" }],
      ro,
    );
    expect(res.ok).toBe(true);
    expect(retrieve).toHaveBeenCalledWith(
      "price_1",
      expect.objectContaining({ expand: expect.any(Array) }),
      ro,
    );
  });

  it("defaults to the platform account ({}) when no options are passed", async () => {
    const { stripe, retrieve } = makeStripe({
      retrieve: {
        id: "price_1",
        active: true,
        type: "one_time",
        unit_amount: 1000,
        product: PRODUCT,
      },
    });
    await validateCartItems(stripe, [
      { priceId: "price_1", quantity: 1, mode: "one_time" },
    ]);
    expect(retrieve).toHaveBeenCalledWith("price_1", expect.anything(), {});
  });

  it("forwards requestOptions to prices.list for a subscription line", async () => {
    const { stripe, list } = makeStripe({
      retrieve: {
        id: "price_sub",
        active: true,
        type: "recurring",
        unit_amount: 1000,
        product: PRODUCT,
      },
      list: {
        data: [
          {
            id: "price_sub",
            active: true,
            type: "recurring",
            unit_amount: 1000,
          },
        ],
      },
    });
    const ro = { stripeAccount: "acct_x" } as Stripe.RequestOptions;
    const res = await validateCartItems(
      stripe,
      [{ priceId: "price_sub", quantity: 1, mode: "subscription" }],
      ro,
    );
    expect(res.ok).toBe(true);
    expect(list).toHaveBeenCalledWith(expect.anything(), ro);
  });
});
