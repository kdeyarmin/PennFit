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

  it("notifies subscribers exactly once even for multi-line input", () => {
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.replaceItems([
      { ...baseItem({ priceId: "price_1" }), quantity: 1 },
      { ...baseItem({ priceId: "price_2", productId: "prod_2" }), quantity: 2 },
    ]);
    // Atomic swap — one commit, one notification, regardless of line count.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cartStore.getSnapshot()).toHaveLength(2);
  });

  it("clears the cart when called with an empty array", () => {
    cartStore.addItem(baseItem(), 3);
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.replaceItems([]);
    expect(cartStore.getSnapshot()).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("cartStore.removeItem — notification and no-op", () => {
  it("notifies subscribers when a line is removed", () => {
    cartStore.addItem(baseItem());
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.removeItem("price_1");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cartStore.getSnapshot()).toHaveLength(0);
  });

  it("is a no-op (still commits, but cart is unchanged) when priceId is unknown", () => {
    cartStore.addItem(baseItem());
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    cartStore.removeItem("price_does_not_exist");
    // The commit still fires (filter produces same-shape array) but the
    // snapshot content is unchanged — no items were dropped.
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });
});

describe("cartStore.setQuantity — additional edge cases", () => {
  it("is a no-op in terms of cart contents when priceId is unknown", () => {
    cartStore.addItem(baseItem(), 3);
    const before = cartStore.getSnapshot();
    cartStore.setQuantity("price_does_not_exist", 10);
    const after = cartStore.getSnapshot();
    // Content is unchanged; the existing item keeps its quantity.
    expect(after[0]!.quantity).toBe(before[0]!.quantity);
    expect(after).toHaveLength(1);
  });

  it("coerces Infinity to 0 and removes the line", () => {
    cartStore.addItem(baseItem(), 3);
    cartStore.setQuantity("price_1", Infinity);
    // Number.isFinite(Infinity) === false → safeQty becomes 0 → line removed.
    expect(cartStore.getSnapshot()).toHaveLength(0);
  });

  it("coerces negative Infinity to 0 and removes the line", () => {
    cartStore.addItem(baseItem(), 3);
    cartStore.setQuantity("price_1", -Infinity);
    expect(cartStore.getSnapshot()).toHaveLength(0);
  });
});

describe("cartStore.setItemMode — additional edge cases", () => {
  it("switches from subscription back to one_time", () => {
    cartStore.addItem(baseItem({ recurringPriceId: "price_sub" }));
    cartStore.setItemMode("price_1", "subscription");
    expect(cartStore.getSnapshot()[0]!.mode).toBe("subscription");
    cartStore.setItemMode("price_1", "one_time");
    expect(cartStore.getSnapshot()[0]!.mode).toBe("one_time");
  });

  it("is a no-op in terms of cart contents when priceId is unknown", () => {
    cartStore.addItem(baseItem({ recurringPriceId: "price_sub" }));
    const before = cartStore.getSnapshot()[0]!.mode;
    cartStore.setItemMode("price_does_not_exist", "subscription");
    expect(cartStore.getSnapshot()[0]!.mode).toBe(before);
  });
});

describe("cartStore.addItem — additional edge cases", () => {
  it("accepts a positive stockCount as available", () => {
    const res = cartStore.addItem(baseItem({ stockCount: 1 }));
    expect(res).toEqual({ ok: true });
    expect(cartStore.getSnapshot()).toHaveLength(1);
  });

  it("uses a default quantity of 1 when quantity is omitted", () => {
    cartStore.addItem(baseItem());
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(1);
  });

  it("caps accumulated quantity at 20 when adding to an existing subscription line", () => {
    cartStore.addItem(
      baseItem({ mode: "subscription", recurringPriceId: "price_sub" }),
      15,
    );
    cartStore.addItem(
      baseItem({ mode: "subscription", recurringPriceId: "price_sub" }),
      10,
    );
    expect(cartStore.getSnapshot()[0]!.quantity).toBe(20);
  });
});

describe("cartStore.getServerSnapshot", () => {
  it("always returns the same stable empty array reference", () => {
    const a = cartStore.getServerSnapshot();
    const b = cartStore.getServerSnapshot();
    expect(a).toBe(b);
    expect(a).toHaveLength(0);
  });

  it("is unaffected by mutations that change getSnapshot", () => {
    const serverRef = cartStore.getServerSnapshot();
    cartStore.addItem(baseItem());
    // Client snapshot now has an item; server snapshot stays empty.
    expect(cartStore.getSnapshot()).toHaveLength(1);
    expect(cartStore.getServerSnapshot()).toBe(serverRef);
    expect(cartStore.getServerSnapshot()).toHaveLength(0);
  });
});
