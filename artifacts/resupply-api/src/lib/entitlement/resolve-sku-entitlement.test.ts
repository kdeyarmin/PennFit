import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCallsByInvocation,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Imported AFTER the mock is installed so the @workspace/resupply-db
// import inside the module resolves to the stubbed client.
import { getOrgScopedClient } from "@workspace/resupply-db";
import { resolveSkuEntitlement } from "./resolve-sku-entitlement";

const NOW = new Date("2026-05-30T12:00:00Z");
const PATIENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "10000000-0000-4000-8000-000000000001";

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// A7032 nasal cushion: every 15 days, 2 per 30-day period.
function stageCushionRule(): void {
  stageSupabaseResponse("sku_hcpcs_map", "select", {
    data: [{ sku_prefix: "CUSHION", hcpcs_code: "A7032" }],
    error: null,
  });
  stageSupabaseResponse("hcpcs_codes", "select", {
    data: {
      code: "A7032",
      min_interval_days: 15,
      max_quantity_per_period: 2,
      period_days: 30,
      active: true,
    },
    error: null,
  });
}

beforeEach(() => supabaseMock.reset());

describe("resolveSkuEntitlement", () => {
  it("scopes every history read to the tenant and current quantity window", async () => {
    stageCushionRule();
    stageSupabaseResponse("fulfillments", "select", { data: [] });
    await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "CUSHION-NASAL-MED",
      now: NOW,
    });
    const reads = getSupabaseFilterCallsByInvocation("fulfillments", "select");
    for (const filters of reads) {
      expect(filters).toContainEqual({ verb: "eq", args: ["org_id", ORG_ID] });
      expect(filters).toContainEqual({
        verb: "eq",
        args: ["patient_id", PATIENT_ID],
      });
      expect(filters).toContainEqual({
        verb: "filter",
        args: ["item_sku", "match", "^(?:CUSHION)"],
      });
    }
    expect(reads[0]).toContainEqual({
      verb: "gte",
      args: ["created_at", isoDaysAgo(30)],
    });
    expect(reads[0]).toContainEqual({
      verb: "lte",
      args: ["created_at", NOW.toISOString()],
    });
    expect(reads.flat().some((filter) => filter.verb === "range")).toBe(false);
  });

  it("uses the newest dispense even though keyset rows are ordered by ID", async () => {
    stageCushionRule();
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: "20000000-0000-4000-8000-000000000001",
          item_sku: "CUSHION-M",
          quantity: 1,
          created_at: isoDaysAgo(25),
        },
        {
          id: "20000000-0000-4000-8000-000000000002",
          item_sku: "CUSHION-L",
          quantity: 1,
          created_at: isoDaysAgo(2),
        },
      ],
    });
    const result = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "CUSHION-M",
      now: NOW,
    });
    expect(result?.lastFulfilledAt).toEqual(new Date(isoDaysAgo(2)));
    expect(result?.daysUntilEligible).toBe(13);
  });

  it("retains an interval anchor older than the quantity window without scanning old history", async () => {
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [{ sku_prefix: "MASK", hcpcs_code: "A7034" }],
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: {
        code: "A7034",
        min_interval_days: 90,
        max_quantity_per_period: 1,
        period_days: 30,
        active: true,
      },
    });
    stageSupabaseResponse("fulfillments", "select", { data: [] });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: "20000000-0000-4000-8000-000000000001",
          item_sku: "MASK-M",
          quantity: 1,
          created_at: isoDaysAgo(40),
        },
      ],
    });
    const result = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "MASK-M",
      now: NOW,
    });
    expect(result).toMatchObject({
      eligible: false,
      daysUntilEligible: 50,
      maxQuantityNow: 1,
    });
    expect(result?.lastFulfilledAt).toEqual(new Date(isoDaysAgo(40)));
    const reads = getSupabaseFilterCallsByInvocation("fulfillments", "select");
    expect(reads).toHaveLength(2);
    expect(reads[1]).toContainEqual({ verb: "limit", args: [1] });
  });
  it("ignores a longer prefix that belongs to a different HCPCS family", async () => {
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [
        { sku_prefix: "MASK", hcpcs_code: "A7034" },
        { sku_prefix: "MASK-FULL", hcpcs_code: "A7030" },
      ],
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: {
        code: "A7034",
        min_interval_days: 90,
        max_quantity_per_period: 1,
        period_days: 90,
        active: true,
      },
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          item_sku: "MASK-FULL-L",
          quantity: 1,
          created_at: isoDaysAgo(1),
          status: "shipped",
        },
      ],
    });
    const result = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "MASK-M",
      now: NOW,
    });
    expect(result).toMatchObject({ eligible: true, hcpcsCode: "A7034" });
  });

  it("includes same-family dispenses beyond the first page of patient history", async () => {
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [
        { sku_prefix: "MASK", hcpcs_code: "A7034" },
        { sku_prefix: "NASAL-INTERFACE", hcpcs_code: "A7034" },
      ],
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: {
        code: "A7034",
        min_interval_days: 90,
        max_quantity_per_period: 1,
        period_days: 90,
        active: true,
      },
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: Array.from({ length: 200 }, (_, index) => ({
        id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        item_sku: "FILTER-DISP",
        quantity: 1,
        created_at: isoDaysAgo(1),
        status: "shipped",
      })),
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: "20000000-0000-4000-8000-000000000200",
          item_sku: "NASAL-INTERFACE-L",
          quantity: 1,
          created_at: isoDaysAgo(2),
          status: "shipped",
        },
      ],
    });
    const result = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "MASK-M",
      now: NOW,
    });
    expect(result).toMatchObject({
      eligible: false,
      daysUntilEligible: 88,
      hcpcsCode: "A7034",
    });
    const reads = getSupabaseFilterCallsByInvocation("fulfillments", "select");
    expect(reads[1]).toContainEqual({
      verb: "gt",
      args: ["id", "20000000-0000-4000-8000-000000000199"],
    });
    expect(reads.flat().some((filter) => filter.verb === "range")).toBe(false);
  });
  it("blocks a too-soon reorder", async () => {
    stageCushionRule();
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          item_sku: "CUSHION-NASAL-MED",
          quantity: 1,
          created_at: isoDaysAgo(2),
          status: "shipped",
        },
      ],
      error: null,
    });

    const r = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "CUSHION-NASAL-MED",
      now: NOW,
    });

    expect(r).not.toBeNull();
    expect(r!.status).toBe("too_soon");
    expect(r!.eligible).toBe(false);
    expect(r!.hcpcsCode).toBe("A7032");
    expect(r!.skuPrefix).toBe("CUSHION");
    expect(r!.daysUntilEligible).toBe(13);
  });

  it("allows a reorder when the patient has no prior dispense", async () => {
    stageCushionRule();
    stageSupabaseResponse("fulfillments", "select", { data: [], error: null });

    const r = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "CUSHION-NASAL-MED",
      now: NOW,
    });

    expect(r!.status).toBe("eligible");
    expect(r!.eligible).toBe(true);
  });

  it("blocks when the per-period quantity cap is already met", async () => {
    stageCushionRule();
    // Two cushions already shipped this period (cap is 2), both old
    // enough that the interval gate is open.
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          item_sku: "CUSHION-NASAL-MED",
          quantity: 1,
          created_at: isoDaysAgo(20),
          status: "shipped",
        },
        {
          item_sku: "CUSHION-NASAL-MED",
          quantity: 1,
          created_at: isoDaysAgo(25),
          status: "shipped",
        },
      ],
      error: null,
    });

    const r = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "CUSHION-NASAL-MED",
      now: NOW,
    });

    expect(r!.status).toBe("quantity_exceeded");
    expect(r!.eligible).toBe(false);
  });

  it("returns null (fail-open) when the SKU maps to no HCPCS family", async () => {
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [{ sku_prefix: "CUSHION", hcpcs_code: "A7032" }],
      error: null,
    });

    const r = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "WIPES-ALCOHOL-PK", // no matching prefix
      now: NOW,
    });

    expect(r).toBeNull();
  });

  it("picks the longest matching SKU prefix", async () => {
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [
        { sku_prefix: "MASK", hcpcs_code: "A7034" },
        { sku_prefix: "MASK-FULL", hcpcs_code: "A7030" },
      ],
      error: null,
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: {
        code: "A7030",
        min_interval_days: 90,
        max_quantity_per_period: 1,
        period_days: 90,
        active: true,
      },
      error: null,
    });
    stageSupabaseResponse("fulfillments", "select", { data: [], error: null });

    const r = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "MASK-FULL-LG",
      now: NOW,
    });

    expect(r!.hcpcsCode).toBe("A7030");
    expect(r!.skuPrefix).toBe("MASK-FULL");
  });

  it("returns null when the mapped HCPCS row is inactive", async () => {
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [{ sku_prefix: "CUSHION", hcpcs_code: "A7032" }],
      error: null,
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: {
        code: "A7032",
        min_interval_days: 15,
        max_quantity_per_period: 2,
        period_days: 30,
        active: false,
      },
      error: null,
    });

    const r = await resolveSkuEntitlement(getOrgScopedClient(ORG_ID), {
      patientId: PATIENT_ID,
      itemSku: "CUSHION-NASAL-MED",
      now: NOW,
    });

    expect(r).toBeNull();
  });
});
