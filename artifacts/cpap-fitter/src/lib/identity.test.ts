// Tests for lib/identity.tsx — focused on the PR change:
// sign-out now clears the cart through cartStore.clear() rather than
// a raw window.localStorage.removeItem("pennpaps_cart_v1").
//
// The vitest environment is "node" (no DOM, no React rendering).
// identity.tsx is a React module, so we don't try to render or call
// the hook directly here. Instead we use two complementary approaches:
//
//   1. Source-analysis assertions (readFileSync) — guard that the PR's
//      structural change is in place: cartStore is imported, and the
//      sign-out path calls cartStore.clear() rather than the old raw
//      localStorage.removeItem(CART_KEY) call.
//
//   2. Behavioural contract verification on the cartStore API — confirm
//      that the method identity.tsx now relies on (cartStore.clear)
//      does what sign-out needs: purges items AND notifies every
//      mounted consumer so the header MiniCart re-renders immediately.
//
// Both angles together guard the regression described in the PR: a raw
// removeItem only cleared localStorage; the shared in-memory state
// remained, so the MiniCart kept showing User A's cart after sign-out.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cartStore, type CartItem } from "@/hooks/use-cart";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "identity.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Source-analysis assertions — guard the PR's structural change.
// ---------------------------------------------------------------------------

describe("identity.tsx — cartStore integration (source structure)", () => {
  it("imports cartStore from the shared hook module", () => {
    // The import must come from @/hooks/use-cart (or a relative
    // equivalent) — not from a private copy or from localStorage directly.
    expect(SRC).toMatch(/import\s*\{[^}]*cartStore[^}]*\}\s*from/);
  });

  it("calls cartStore.clear() in the sign-out path", () => {
    expect(SRC).toContain("cartStore.clear()");
  });

  it("does NOT call the old raw localStorage.removeItem for the cart key", () => {
    // The raw removeItem that the PR replaced must be gone. The key
    // "pennpaps_cart_v1" may legitimately appear in comments; the
    // important thing is that there's no active removeItem("pennpaps_cart_v1")
    // call in production code.
    expect(SRC).not.toMatch(
      /localStorage\.removeItem\s*\(\s*["']pennpaps_cart_v1["']\s*\)/,
    );
  });

  it("still clears the wishlist, compare, and recently-viewed keys directly", () => {
    // Only the cart key moved to the store; the other per-device keys
    // are cleared via raw localStorage — confirm none were accidentally
    // removed during the refactor.
    expect(SRC).toContain('removeItem("pennpaps:wishlist:v1")');
    expect(SRC).toContain('removeItem("pennpaps:compare:v1")');
    expect(SRC).toContain('removeItem("pennpaps_recently_viewed_v1")');
  });

  it("exports useShopIdentity as the primary hook", () => {
    expect(SRC).toContain("export function useShopIdentity");
  });
});

// ---------------------------------------------------------------------------
// cartStore.clear() — behavioural contract that identity.tsx relies on.
//
// These tests validate the exact guarantees that make cartStore.clear()
// the right replacement for raw localStorage.removeItem in sign-out:
//   a) The in-memory store is emptied (not just localStorage).
//   b) Every subscriber (including the always-mounted header MiniCart)
//      is notified, so the component re-renders without a page reload.
// ---------------------------------------------------------------------------

function baseItem(
  overrides: Partial<Omit<CartItem, "quantity">> = {},
): Omit<CartItem, "quantity"> {
  return {
    productId: "prod_sign_out",
    priceId: "price_sign_out",
    name: "CPAP Mask",
    unitAmountCents: 4999,
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

const cleanups: Array<() => void> = [];
beforeEach(() => {
  cartStore.clear();
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  cartStore.clear();
});

describe("cartStore.clear() — sign-out contract", () => {
  it("empties the in-memory cart immediately (no stale state for User B)", () => {
    cartStore.addItem(baseItem());
    cartStore.addItem(
      baseItem({ priceId: "price_2", productId: "prod_2" }),
    );
    expect(cartStore.getSnapshot()).toHaveLength(2);

    cartStore.clear();

    expect(cartStore.getSnapshot()).toHaveLength(0);
  });

  it("notifies the header MiniCart subscriber so it re-renders without a reload", () => {
    // Simulate the header MiniCart being subscribed before sign-out.
    const miniCartRender = vi.fn();
    cleanups.push(cartStore.subscribe(miniCartRender));

    cartStore.addItem(baseItem());
    miniCartRender.mockClear(); // isolate the sign-out notification

    // sign-out calls cartStore.clear():
    cartStore.clear();

    expect(miniCartRender).toHaveBeenCalledTimes(1);
  });

  it("notifies ALL simultaneous subscribers (cart page + MiniCart)", () => {
    const miniCart = vi.fn();
    const cartPage = vi.fn();
    cleanups.push(cartStore.subscribe(miniCart), cartStore.subscribe(cartPage));

    cartStore.addItem(baseItem());
    miniCart.mockClear();
    cartPage.mockClear();

    cartStore.clear();

    expect(miniCart).toHaveBeenCalledTimes(1);
    expect(cartPage).toHaveBeenCalledTimes(1);
  });

  it("getSnapshot returns a stable empty reference after clear (no re-render loop)", () => {
    cartStore.addItem(baseItem());
    cartStore.clear();
    const snap1 = cartStore.getSnapshot();
    const snap2 = cartStore.getSnapshot();
    expect(snap1).toBe(snap2);
    expect(snap1).toEqual([]);
  });

  it("is idempotent: clearing an already-empty cart is safe and still notifies", () => {
    // sign-out may be called on a guest who never added anything;
    // cartStore.clear() must not throw and must still emit so any
    // subscribed component gets a chance to re-render.
    expect(cartStore.getSnapshot()).toHaveLength(0);
    const spy = vi.fn();
    cleanups.push(cartStore.subscribe(spy));
    expect(() => cartStore.clear()).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a new item added after sign-out (clear) appears fresh, not carrying User A's data", () => {
    cartStore.addItem(baseItem());
    cartStore.clear(); // sign-out

    // User B signs in and adds their own item.
    const userBItem = baseItem({
      priceId: "price_user_b",
      productId: "prod_user_b",
      name: "CPAP Humidifier",
    });
    cartStore.addItem(userBItem);

    const items = cartStore.getSnapshot();
    expect(items).toHaveLength(1);
    expect(items[0]!.priceId).toBe("price_user_b");
  });
});
