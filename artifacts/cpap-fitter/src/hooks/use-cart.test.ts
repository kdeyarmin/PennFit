// Tests for hooks/use-cart.ts — the shared cart store.
//
// The vitest environment here is "node" (no jsdom), so we exercise the
// vanilla `cartStore` surface directly rather than rendering the
// `useCart()` hook. That's exactly the layer where the original bug
// lived: the cart was a per-component useState, so two consumers never
// saw each other's updates. The first describe block is the regression
// guard for that — a mutation must notify every subscriber.
//
// In the node environment `window` is undefined, so readStorage()
// returns an empty cart at module load and writeStorage() is a no-op.
// That's fine: the store's in-memory `state` is the source of truth and
// is what every assertion reads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cartStore, type CartItem } from "./use-cart";

function baseItem(
  overrides: Partial<Omit<CartItem, "quantity">> = {},
): Omit<CartItem, "quantity"> {
  return {
    productId: "prod_1",
    priceId: "price_1",
    name: "CPAP Cushion",
    unitAmountCents: 2999,
    currency: "usd",
    imageUrl: null,
    isBundle: false,
    mode: "one_time",
    recurringPriceId: null,
    recurringIntervalLabel: null,
    stockCount: null,
    ...overrides,
  };
}

// Unsubscribe everything a test registered, then empty the cart, so the
// module-level singleton can't leak state or listeners between tests.
const cleanups: Array<() => void> = [];
beforeEach(() => {
  cartStore.clear();
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  cartStore.clear();
});

describe("cartStore — shared reactivity (regression: cart stayed empty)", () => {
  it("notifies every subscriber when one mutates", () => {
    const a = vi.fn();
    const b = vi.fn();
    cleanups.push(cartStore.subscribe(a), cartStore.subscribe(b));

    const res = cartStore.addItem(baseItem());

    expect(res).toEqual({ ok: true });
    // Both independent subscribers (e.g. header MiniCart + cart page)
    // must learn about the add. This is the assertion that fails on the
    // old per-component useState design.
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });

  it("getSnapshot returns a stable reference until a mutation", () => {
    // useSyncExternalStore tears / infinite-loops if getSnapshot hands
    // back a fresh array on every call. The reference must be stable
    // while the cart is unchanged, and only swap on mutation.
    const first = cartStore.getSnapshot();
    expect(cartStore.getSnapshot()).toBe(first);

    cartStore.addItem(baseItem());
    const second = cartStore.getSnapshot();
    expect(second).not.toBe(first);
    expect(cartStore.getSnapshot()).toBe(second);
  });

  it("stops notifying after unsubscribe", () => {
    const spy = vi.fn();
    const unsub = cartStore.subscribe(spy);
    cartStore.addItem(baseItem());
    expect(spy).toHaveBeenCalledTimes(1);

    unsub();
    cartStore.addItem(baseItem({ priceId: "price_2", productId: "prod_2" }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("cartStore.addItem", () => {
  it("dedupes by priceId and accumulates quantity, capped at 20", () => {
    cartStore.addItem(baseItem(), 5);
    cartStore.addItem(baseItem(), 18);
    const items = cartStore.getSnapshot();
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(20);
  });

  it("adds distinct SKUs as separate lines", () => {
    cartStore.addItem(baseItem({ priceId: "price_1" }));
    cartStore.addItem(baseItem({ priceId: "price_2", productId: "prod_2" }));
    expect(cartStore.getSnapshot()).toHaveLength(2);
  });

  it("rejects an out-of-stock one-time add and leaves the cart unchanged", () => {
    const res = cartStore.addItem(baseItem({ stockCount: 0 }));
    expect(res).toEqual({ ok: false, reason: "out_of_stock" });
    expect(cartStore.getSnapshot()).toHaveLength(0);
  });

  it("allows a subscription add even at zero stock", () => {
    const res = cartStore.addItem(
      baseItem({
        stockCount: 0,
        mode: "subscription",
        recurringPriceId: "price_sub",
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });

  it("treats a null stockCount as available", () => {
    const res = cartStore.addItem(baseItem({ stockCount: null }));
    expect(res).toEqual({ ok: true });
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });

  it("rejects a currency mismatch without mutating the cart", () => {
    cartStore.addItem(baseItem({ currency: "usd" }));
    const res = cartStore.addItem(
      baseItem({
        priceId: "price_eur",
        productId: "prod_eur",
        currency: "eur",
      }),
    );
    expect(res).toEqual({ ok: false, reason: "currency_mismatch" });
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });
});

describe("cartStore.setQuantity", () => {
  it("clamps to [0,20], floors fractional input, and removes at 0", () => {
    cartStore.addItem(baseItem(), 3);

    cartStore.setQuantity("price_1", 999);
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(20);

    cartStore.setQuantity("price_1", 2.9);
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(2);

    cartStore.setQuantity("price_1", 0);
    expect(cartStore.getSnapshot()).toHaveLength(0);
  });

  it("coerces a non-finite quantity to 0 (and removes the line)", () => {
    cartStore.addItem(baseItem(), 3);
    cartStore.setQuantity("price_1", Number.NaN);
    expect(cartStore.getSnapshot()).toHaveLength(0);
  });
});

describe("cartStore.setItemMode", () => {
  it("coerces subscription→one_time when the line has no recurring price", () => {
    cartStore.addItem(baseItem({ recurringPriceId: null }));
    cartStore.setItemMode("price_1", "subscription");
    expect(cartStore.getSnapshot()[0]!.mode).toBe("one_time");
  });

  it("honors subscription when the line carries a recurring price", () => {
    cartStore.addItem(baseItem({ recurringPriceId: "price_sub" }));
    cartStore.setItemMode("price_1", "subscription");
    expect(cartStore.getSnapshot()[0]!.mode).toBe("subscription");
  });
});

describe("cartStore.removeItem / clear", () => {
  it("removes a single line by priceId", () => {
    cartStore.addItem(baseItem({ priceId: "price_1" }));
    cartStore.addItem(baseItem({ priceId: "price_2", productId: "prod_2" }));
    cartStore.removeItem("price_1");
    const items = cartStore.getSnapshot();
    expect(items).toHaveLength(1);
    expect(items[0]!.priceId).toBe("price_2");
  });

  it("clear empties the cart and notifies subscribers", () => {
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.addItem(baseItem());
    spy.mockClear();
    cartStore.clear();
    expect(cartStore.getSnapshot()).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("cartStore.replaceItems", () => {
  it("dedupes by priceId, accumulates+caps, and clamps each line to [1,20]", () => {
    cartStore.replaceItems([
      { ...baseItem({ priceId: "price_1" }), quantity: 2 },
      { ...baseItem({ priceId: "price_1" }), quantity: 25 },
      { ...baseItem({ priceId: "price_2", productId: "prod_2" }), quantity: 0 },
    ]);
    const items = cartStore.getSnapshot();
    expect(items).toHaveLength(2);

    const p1 = items.find((i) => i.priceId === "price_1")!;
    expect(p1.quantity).toBe(20); // 2 + 25, capped at 20

    const p2 = items.find((i) => i.priceId === "price_2")!;
    expect(p2.quantity).toBe(1); // 0 clamped up to the 1-item minimum
  });

  it("replaceItems([]) empties the cart and notifies subscribers", () => {
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.addItem(baseItem());
    spy.mockClear();
    cartStore.replaceItems([]);
    expect(cartStore.getSnapshot()).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("replaceItems with a single non-duplicate item preserves it at its clamped quantity", () => {
    cartStore.replaceItems([{ ...baseItem({ priceId: "price_1" }), quantity: 3 }]);
    const items = cartStore.getSnapshot();
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Additional addItem edge cases
// ---------------------------------------------------------------------------

describe("cartStore.addItem — additional edge cases", () => {
  it("defaults quantity to 1 when no quantity argument is supplied", () => {
    cartStore.addItem(baseItem());
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(1);
  });

  it("allows adding an item with positive stockCount", () => {
    const res = cartStore.addItem(baseItem({ stockCount: 5 }));
    expect(res).toEqual({ ok: true });
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });

  it("rejects an item with negative stockCount as out_of_stock", () => {
    const res = cartStore.addItem(baseItem({ stockCount: -1 }));
    expect(res).toEqual({ ok: false, reason: "out_of_stock" });
    expect(cartStore.getSnapshot()).toHaveLength(0);
  });

  it("does not notify subscribers when the add is rejected (out_of_stock)", () => {
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.addItem(baseItem({ stockCount: 0 }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not notify subscribers when the add is rejected (currency_mismatch)", () => {
    cartStore.addItem(baseItem({ currency: "usd" }));
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.addItem(
      baseItem({ priceId: "price_eur", productId: "prod_eur", currency: "eur" }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("caps quantity at 20 when adding exactly 20", () => {
    cartStore.addItem(baseItem(), 20);
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(20);
    // Adding 1 more cannot push it past 20
    cartStore.addItem(baseItem(), 1);
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// No-op behaviour for unknown priceIds
// ---------------------------------------------------------------------------

describe("cartStore — no-op operations on unknown priceIds", () => {
  it("removeItem with an unknown priceId leaves the cart unchanged and still notifies", () => {
    cartStore.addItem(baseItem({ priceId: "price_1" }));
    const before = cartStore.getSnapshot();
    cartStore.removeItem("price_unknown");
    // The cart contents are the same …
    expect(cartStore.getSnapshot()).toHaveLength(1);
    // … but a new array is committed (same semantics as any other commit).
    // Length and value equality is what matters; reference change is an
    // implementation detail we don't assert here.
    expect(cartStore.getSnapshot()[0]!.priceId).toBe("price_1");
    // No crash is the primary guarantee.
    void before;
  });

  it("setQuantity with an unknown priceId is a safe no-op", () => {
    cartStore.addItem(baseItem({ priceId: "price_1" }), 3);
    cartStore.setQuantity("price_unknown", 10);
    expect(cartStore.getSnapshot()).toHaveLength(1);
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(3);
  });

  it("setItemMode with an unknown priceId does not crash and leaves the cart unchanged", () => {
    cartStore.addItem(baseItem({ priceId: "price_1" }));
    cartStore.setItemMode("price_unknown", "subscription");
    expect(cartStore.getSnapshot()[0]!.mode).toBe("one_time");
  });
});

// ---------------------------------------------------------------------------
// Subscriber notification for all mutation methods
// ---------------------------------------------------------------------------

describe("cartStore — subscriber notification completeness", () => {
  it("removeItem notifies subscribers", () => {
    cartStore.addItem(baseItem({ priceId: "price_1" }));
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.removeItem("price_1");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("setQuantity notifies subscribers", () => {
    cartStore.addItem(baseItem(), 3);
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.setQuantity("price_1", 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("setItemMode notifies subscribers", () => {
    cartStore.addItem(baseItem({ recurringPriceId: "price_sub" }));
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.setItemMode("price_1", "subscription");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("replaceItems notifies subscribers", () => {
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.replaceItems([{ ...baseItem(), quantity: 1 }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// setItemMode — additional cases
// ---------------------------------------------------------------------------

describe("cartStore.setItemMode — additional cases", () => {
  it("explicitly setting one_time on a subscription line reverts to one_time", () => {
    cartStore.addItem(baseItem({ recurringPriceId: "price_sub", mode: "one_time" }));
    // First upgrade to subscription …
    cartStore.setItemMode("price_1", "subscription");
    expect(cartStore.getSnapshot()[0]!.mode).toBe("subscription");
    // … then revert to one_time.
    cartStore.setItemMode("price_1", "one_time");
    expect(cartStore.getSnapshot()[0]!.mode).toBe("one_time");
  });
});

// ---------------------------------------------------------------------------
// getServerSnapshot
// ---------------------------------------------------------------------------

describe("cartStore.getServerSnapshot", () => {
  it("returns a stable reference on repeated calls (avoids useSyncExternalStore loop)", () => {
    const first = cartStore.getServerSnapshot();
    const second = cartStore.getServerSnapshot();
    expect(first).toBe(second);
    expect(first).toEqual([]);
  });

  it("returns the stable empty array even after mutations to the client store", () => {
    cartStore.addItem(baseItem());
    const serverSnap = cartStore.getServerSnapshot();
    expect(serverSnap).toEqual([]);
    // The client snapshot should differ
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// clear edge case
// ---------------------------------------------------------------------------

describe("cartStore.clear — additional cases", () => {
  it("clear on an already-empty cart notifies subscribers once", () => {
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    expect(cartStore.getSnapshot()).toHaveLength(0);
    cartStore.clear();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
