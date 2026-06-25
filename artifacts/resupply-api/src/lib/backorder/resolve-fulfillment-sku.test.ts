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
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { resolveFulfillmentSku } from "./resolve-fulfillment-sku";

const supabaseMock = installSupabaseMock();

// Tenant context. resolveFulfillmentSku now takes an OrgScopedClient so
// every shop_backorders / shop_sku_substitutes read is filtered by
// org_id — a backorder/substitution row from another tenant for the same
// SKU string must never match.
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const orgClient = () => getOrgScopedClient(ORG_ID);

beforeEach(() => {
  supabaseMock.reset();
});

describe("resolveFulfillmentSku", () => {
  it("passes through when primary is not backordered", async () => {
    stageSupabaseResponse("shop_backorders", "select", { data: null });
    const r = await resolveFulfillmentSku(
      orgClient(),
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
      orgClient(),
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
      orgClient(),
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
      orgClient(),
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
      orgClient(),
      "AF20-S",
    );
    expect(r.substituted).toBe(false);
    expect(r.noAlternative).toBe(true);
  });

  it("scopes every read to the caller's org_id (no cross-tenant SKU collision)", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      data: { id: "bo_1" },
    });
    stageSupabaseResponse("shop_sku_substitutes", "select", {
      data: [{ alternative_sku: "AF20-M", priority: 1 }],
    });
    stageSupabaseResponse("shop_backorders", "select", { data: [] });

    await resolveFulfillmentSku(orgClient(), "AF20-S");

    // The org-scoped facade must have appended `.eq("org_id", ORG_ID)`
    // to BOTH tenant-scoped reads — otherwise another tenant's backorder
    // / substitution config for the same SKU string would match.
    const backorderFilters = getSupabaseFilterCalls("shop_backorders", "select");
    expect(
      backorderFilters.some(
        (f) => f.verb === "eq" && f.args[0] === "org_id" && f.args[1] === ORG_ID,
      ),
    ).toBe(true);
    const substituteFilters = getSupabaseFilterCalls(
      "shop_sku_substitutes",
      "select",
    );
    expect(
      substituteFilters.some(
        (f) => f.verb === "eq" && f.args[0] === "org_id" && f.args[1] === ORG_ID,
      ),
    ).toBe(true);
  });
});
