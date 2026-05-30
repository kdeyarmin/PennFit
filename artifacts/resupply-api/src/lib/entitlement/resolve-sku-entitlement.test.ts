import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Imported AFTER the mock is installed so the @workspace/resupply-db
// import inside the module resolves to the stubbed client.
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { resolveSkuEntitlement } from "./resolve-sku-entitlement";

const NOW = new Date("2026-05-30T12:00:00Z");
const PATIENT_ID = "00000000-0000-4000-8000-000000000001";

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
  it("blocks a too-soon reorder", async () => {
    stageCushionRule();
    stageSupabaseResponse("fulfillments", "select", {
      data: [{ quantity: 1, created_at: isoDaysAgo(2), status: "shipped" }],
      error: null,
    });

    const r = await resolveSkuEntitlement(getSupabaseServiceRoleClient(), {
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

    const r = await resolveSkuEntitlement(getSupabaseServiceRoleClient(), {
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
        { quantity: 1, created_at: isoDaysAgo(20), status: "shipped" },
        { quantity: 1, created_at: isoDaysAgo(25), status: "shipped" },
      ],
      error: null,
    });

    const r = await resolveSkuEntitlement(getSupabaseServiceRoleClient(), {
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

    const r = await resolveSkuEntitlement(getSupabaseServiceRoleClient(), {
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

    const r = await resolveSkuEntitlement(getSupabaseServiceRoleClient(), {
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

    const r = await resolveSkuEntitlement(getSupabaseServiceRoleClient(), {
      patientId: PATIENT_ID,
      itemSku: "CUSHION-NASAL-MED",
      now: NOW,
    });

    expect(r).toBeNull();
  });
});
