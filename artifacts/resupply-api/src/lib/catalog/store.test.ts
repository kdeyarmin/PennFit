// Unit tests for the catalog projection + low-stock semantics.
//
// The projection is where "is this SKU low?" is decided, and it has one
// rule that is easy to get wrong in both directions: an UNTRACKED SKU
// (stock_count NULL) is never low. Warning on a SKU nobody asked us to
// count trains operators to ignore the badge; silently treating NULL as 0
// would flag every consumable a tenant deliberately left untracked.

import { describe, expect, it } from "vitest";

import { DEFAULT_LOW_STOCK_THRESHOLD } from "./categories";
import { projectProduct, type ProductRow } from "./store";

function row(over: Partial<ProductRow> = {}): ProductRow {
  return {
    org_id: "org-1",
    sku: "CUSHION-M",
    name: "Nasal cushion (M)",
    description: null,
    category: "cushion",
    manufacturer: null,
    model_number: null,
    unit_of_measure: "each",
    stock_count: 10,
    low_stock_threshold: 3,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("projectProduct — low-stock semantics", () => {
  it("is not low when comfortably above the threshold", () => {
    expect(projectProduct(row({ stock_count: 10 })).lowStock).toBe(false);
  });

  it("is low AT the threshold, not just below it", () => {
    // "Reorder point" means reorder when you reach it — an off-by-one here
    // means the alert fires one unit too late, every time.
    expect(
      projectProduct(row({ stock_count: 3, low_stock_threshold: 3 })).lowStock,
    ).toBe(true);
  });

  it("is low below the threshold, including at zero", () => {
    expect(projectProduct(row({ stock_count: 0 })).lowStock).toBe(true);
  });

  it("falls back to the default threshold when none is set", () => {
    const p = projectProduct(
      row({
        stock_count: DEFAULT_LOW_STOCK_THRESHOLD,
        low_stock_threshold: null,
      }),
    );
    expect(p.lowStockThreshold).toBe(DEFAULT_LOW_STOCK_THRESHOLD);
    expect(p.lowStock).toBe(true);
  });

  it("treats an UNTRACKED sku as neither low nor zero", () => {
    const p = projectProduct(
      row({ stock_count: null, low_stock_threshold: 3 }),
    );
    expect(p.stockCount).toBeNull();
    // No count means no reorder point to report, and nothing to warn about.
    expect(p.lowStockThreshold).toBeNull();
    expect(p.lowStock).toBe(false);
  });

  it("keeps an untracked sku un-flagged even with a zero threshold", () => {
    // Guards the `0` falsiness trap: `threshold ?? DEFAULT` must not treat a
    // deliberate 0 as unset, and NULL stock must still short-circuit first.
    const p = projectProduct(
      row({ stock_count: null, low_stock_threshold: 0 }),
    );
    expect(p.lowStock).toBe(false);
  });

  it("respects an explicit zero threshold on a tracked sku", () => {
    const atZero = projectProduct(
      row({ stock_count: 0, low_stock_threshold: 0 }),
    );
    expect(atZero.lowStockThreshold).toBe(0);
    expect(atZero.lowStock).toBe(true);

    const one = projectProduct(row({ stock_count: 1, low_stock_threshold: 0 }));
    expect(one.lowStock).toBe(false);
  });

  it("carries the descriptive fields through unchanged", () => {
    const p = projectProduct(
      row({ manufacturer: "ResMed", model_number: "63052", description: "d" }),
    );
    expect(p.manufacturer).toBe("ResMed");
    expect(p.modelNumber).toBe("63052");
    expect(p.description).toBe("d");
    expect(p.unitOfMeasure).toBe("each");
  });
});
