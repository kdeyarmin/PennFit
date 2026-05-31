// Unit tests for fetchUnitCostsBySku (Phase 0 / F1 cost capture).
//
// Pins the two contracts the write paths rely on:
//   * de-dupe + single round-trip; absent SKU != zero cost
//   * fail-soft — a query error OR a thrown client returns an empty map
//     (so cost capture can never break the order/claim write it decorates)

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { fetchUnitCostsBySku } from "./product-cost-lookup";

beforeEach(() => {
  supabaseMock.reset();
});

describe("fetchUnitCostsBySku", () => {
  it("returns an empty map and skips the DB when no usable SKUs", async () => {
    const out = await fetchUnitCostsBySku([null, undefined, ""]);
    expect(out.size).toBe(0);
    expect(getSupabaseCallCount("product_costs", "select")).toBe(0);
  });

  it("de-dupes SKUs into a single query and maps found rows", async () => {
    stageSupabaseResponse("product_costs", "select", {
      data: [
        { sku: "MASK", unit_cost_cents: 4200, cost_source: "invoice" },
        { sku: "CUSHION", unit_cost_cents: 1850, cost_source: "manual" },
      ],
    });
    const out = await fetchUnitCostsBySku(["MASK", "MASK", "CUSHION", null]);
    expect(getSupabaseCallCount("product_costs", "select")).toBe(1);
    expect(out.get("MASK")).toEqual({
      unitCostCents: 4200,
      costSource: "invoice",
    });
    expect(out.get("CUSHION")).toEqual({
      unitCostCents: 1850,
      costSource: "manual",
    });
    expect(out.size).toBe(2);
  });

  it("omits a SKU with no recorded cost (absent, not zero)", async () => {
    stageSupabaseResponse("product_costs", "select", {
      data: [{ sku: "MASK", unit_cost_cents: 4200, cost_source: "invoice" }],
    });
    const out = await fetchUnitCostsBySku(["MASK", "TUBING"]);
    expect(out.has("MASK")).toBe(true);
    expect(out.has("TUBING")).toBe(false);
  });

  it("ignores rows missing a numeric cost", async () => {
    stageSupabaseResponse("product_costs", "select", {
      data: [
        { sku: "MASK", unit_cost_cents: null, cost_source: "manual" },
        { sku: "CUSHION", unit_cost_cents: 1850, cost_source: "manual" },
      ],
    });
    const out = await fetchUnitCostsBySku(["MASK", "CUSHION"]);
    expect(out.has("MASK")).toBe(false);
    expect(out.get("CUSHION")?.unitCostCents).toBe(1850);
  });

  it("defaults cost_source to 'manual' when missing/non-string", async () => {
    stageSupabaseResponse("product_costs", "select", {
      data: [{ sku: "MASK", unit_cost_cents: 4200, cost_source: null }],
    });
    const out = await fetchUnitCostsBySku(["MASK"]);
    expect(out.get("MASK")).toEqual({
      unitCostCents: 4200,
      costSource: "manual",
    });
  });

  it("fails soft on a query error (empty map + warn)", async () => {
    stageSupabaseResponse("product_costs", "select", {
      error: { message: "boom" },
    });
    const warn = vi.fn();
    const out = await fetchUnitCostsBySku(["MASK"], { warn });
    expect(out.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("fails soft when the client throws (empty map + warn)", async () => {
    stageSupabaseResponse("product_costs", "select", {
      throws: new Error("network down"),
    });
    const warn = vi.fn();
    const out = await fetchUnitCostsBySku(["MASK"], { warn });
    expect(out.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
