// Unit tests for the catalog projection + low-stock semantics.
//
// The projection is where "is this SKU low?" is decided, and it has one
// rule that is easy to get wrong in both directions: an UNTRACKED SKU
// (stock_count NULL) is never low. Warning on a SKU nobody asked us to
// count trains operators to ignore the badge; silently treating NULL as 0
// would flag every consumable a tenant deliberately left untracked.

import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { DEFAULT_LOW_STOCK_THRESHOLD } from "./categories";
import { listProducts, projectProduct, type ProductRow } from "./store";

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

describe("listProducts — search escaping", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  /** The `or=` filter string the read applied, or null if it applied none. */
  async function searchFilter(search: string): Promise<string | null> {
    stageSupabaseResponse("products", "select", { data: [], count: 0 });
    await listProducts("00000000-0000-4000-8000-000000000001", { search });
    const or = getSupabaseFilterCalls("products", "select").find(
      (f) => f.verb === "or",
    );
    return or ? String(or.args[0]) : null;
  }

  it("keeps the searched-for string intact through a comma", async () => {
    // Regression: delimiters were REPLACED WITH SPACES to keep the `.or()`
    // logic tree parseable, which quietly changed what was being searched
    // for — "N30i, small" went looking for the literal "N30i  small" and
    // matched nothing, on a catalog where the row was right there. Quoting
    // is what makes the search match; stripping only made it parse.
    expect(await searchFilter("N30i, small")).toBe(
      'sku.ilike."*N30i, small*",name.ilike."*N30i, small*"',
    );
  });

  it("escapes LIKE wildcards instead of leaving them live", async () => {
    // `%` and `_` were passed straight through, so a search for "50%"
    // matched every SKU containing "50" — and one for "A_B" matched "AxB".
    expect(await searchFilter("50%")).toBe(
      "sku.ilike.*50\\%*,name.ilike.*50\\%*",
    );
  });

  it("applies no filter for a whitespace-only search", async () => {
    expect(await searchFilter("   ")).toBeNull();
  });
});
