// Tests for resolveFulfillmentSku.
//
// Coverage:
//   * Primary not backordered → pass-through
//   * Primary backordered, no substitutes → noAlternative=true
//   * Primary backordered, priority-1 alt available → uses alt
//   * Primary backordered, priority-1 alt ALSO backordered → falls
//     through to priority-2

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { resolveFulfillmentSku } from "./resolve-fulfillment-sku";

const supabaseMock = installSupabaseMock();

beforeEach(() => {
  supabaseMock.reset();
});

describe("resolveFulfillmentSku", () => {
  it("passes through when primary is not backordered", async () => {
    stageSupabaseResponse("shop_backorders", "select", { data: null });
    const r = await resolveFulfillmentSku(
      getSupabaseServiceRoleClient(),
      "AF20-S",
    );
    expect(r).toEqual({ sku: "AF20-S", substituted: false });
  });

  it("returns noAlternative when primary backordered + no substitutes", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      data: { id: "bo_1" },
    });
    stageSupabaseResponse("shop_sku_substitutes", "select", { data: [] });
    const r = await resolveFulfillmentSku(
      getSupabaseServiceRoleClient(),
      "AF20-S",
    );
    expect(r.substituted).toBe(false);
    expect(r.noAlternative).toBe(true);
    expect(r.sku).toBe("AF20-S");
  });

  it("uses the priority-1 alternative when available", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      data: { id: "bo_1" },
    });
    stageSupabaseResponse("shop_sku_substitutes", "select", {
      data: [
        { alternative_sku: "AF20-M", priority: 1 },
        { alternative_sku: "AF30-S", priority: 2 },
      ],
    });
    // The second .in() lookup finds no backordered alternatives.
    stageSupabaseResponse("shop_backorders", "select", { data: [] });

    const r = await resolveFulfillmentSku(
      getSupabaseServiceRoleClient(),
      "AF20-S",
    );
    expect(r.substituted).toBe(true);
    expect(r.sku).toBe("AF20-M");
    expect(r.substitutedFromSku).toBe("AF20-S");
  });

  it("falls through priority when the higher-priority alt is also backordered", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      data: { id: "bo_1" },
    });
    stageSupabaseResponse("shop_sku_substitutes", "select", {
      data: [
        { alternative_sku: "AF20-M", priority: 1 },
        { alternative_sku: "AF30-S", priority: 2 },
      ],
    });
    // AF20-M is on backorder too — only AF30-S survives.
    stageSupabaseResponse("shop_backorders", "select", {
      data: [{ sku: "AF20-M" }],
    });

    const r = await resolveFulfillmentSku(
      getSupabaseServiceRoleClient(),
      "AF20-S",
    );
    expect(r.substituted).toBe(true);
    expect(r.sku).toBe("AF30-S");
  });

  it("returns noAlternative when every alt is also backordered", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      data: { id: "bo_1" },
    });
    stageSupabaseResponse("shop_sku_substitutes", "select", {
      data: [{ alternative_sku: "AF20-M", priority: 1 }],
    });
    stageSupabaseResponse("shop_backorders", "select", {
      data: [{ sku: "AF20-M" }],
    });

    const r = await resolveFulfillmentSku(
      getSupabaseServiceRoleClient(),
      "AF20-S",
    );
    expect(r.substituted).toBe(false);
    expect(r.noAlternative).toBe(true);
  });
});
