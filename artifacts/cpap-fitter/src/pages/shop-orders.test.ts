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