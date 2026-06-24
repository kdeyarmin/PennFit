// Tests for pages/shop-orders.tsx
//
// PR change: replaced window.alert() in the onLoadMore error handler
// with a toast notification (variant: "destructive"). The toast is
// more accessible and consistent with the app's design system.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "shop-orders.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Toast import
// ---------------------------------------------------------------------------

describe("shop-orders — toast import", () => {
  it("imports toast from @/hooks/use-toast", () => {
    expect(SRC).toContain('from "@/hooks/use-toast"');
    expect(SRC).toContain("toast");
  });
});

// ---------------------------------------------------------------------------
// onLoadMore error handler — toast instead of window.alert
// ---------------------------------------------------------------------------

describe("shop-orders onLoadMore — error toast", () => {
  it("calls toast() on load-more failure", () => {
    expect(SRC).toContain("toast({");
  });

  it('uses variant: "destructive" for the error toast', () => {
    expect(SRC).toContain('variant: "destructive"');
  });

  it('uses title "Couldn\'t load more orders"', () => {
    expect(SRC).toContain('"Couldn\'t load more orders"');
  });

  it("includes the error message as description when it is an Error instance", () => {
    expect(SRC).toContain(
      "description: err instanceof Error ? err.message : undefined",
    );
  });

  it("no longer uses window.alert in the load-more error path", () => {
    expect(SRC).not.toContain("window.alert");
  });
});

// ---------------------------------------------------------------------------
// Regression: core shop-orders behaviour
// ---------------------------------------------------------------------------

describe("shop-orders — regression: core behaviour retained", () => {
  it("still fetches orders with fetchMyOrders", () => {
    expect(SRC).toContain("fetchMyOrders");
  });

  it("still has onLoadMore / load-more cursor logic", () => {
    expect(SRC).toContain("cursor");
    expect(SRC).toContain("loadingMore");
  });
});

describe("shop-orders — self-serve cancel guards", () => {
  // The cancel button must not show once an order is fulfilled. A pickup
  // order never gets shipped_at, so the gate must also check pickedUpAt —
  // otherwise the button persists after the customer collects in store.
  it("gates the Cancel button on pickup collection, not just shipping", () => {
    expect(SRC).toContain("order.pickup?.pickedUpAt == null");
    expect(SRC).toContain("order.shippedAt === null");
    expect(SRC).toContain("order.deliveredAt === null");
  });

  // A terminal failure (already shipped / picked up / refunded) can never
  // succeed on retry, so the button is dropped instead of re-offered.
  it("treats unfulfillable states as terminal (no infinite retry)", () => {
    expect(SRC).toContain("TERMINAL_CANCEL_CODES");
    expect(SRC).toContain("order_already_picked_up");
    expect(SRC).toContain('phase === "error" && terminal');
  });

  // On success the card flips to its refunded presentation so the stale
  // "Paid" badge + address-edit / return controls don't linger.
  it("flips the card to a refunded presentation after a successful cancel", () => {
    expect(SRC).toContain("onCanceled");
    expect(SRC).toContain("setCanceled(true)");
    expect(SRC).toContain('canceled ? "Refunded" : "Paid"');
  });

  // Double-submit guard on the confirm action.
  it("guards against a double-submit while canceling", () => {
    expect(SRC).toContain('if (phase === "canceling") return;');
  });
});
