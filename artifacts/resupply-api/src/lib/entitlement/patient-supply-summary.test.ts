import { beforeEach, describe, expect, it } from "vitest";
import {
  installSupabaseMock,
  stageSupabaseResponse as stage,
  getSupabaseCallCount,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";
const db = installSupabaseMock();
import { getOrgScopedClient } from "@workspace/resupply-db";
import { loadPatientSupplySummary } from "./patient-supply-summary";
const now = new Date("2026-09-10T12:00:00Z");
const ago = (days: number) =>
  new Date(now.getTime() - days * 86400000).toISOString();
function references() {
  stage("sku_hcpcs_map", "select", {
    data: [
      { sku_prefix: "MASK", hcpcs_code: "A7034" },
      { sku_prefix: "MASK-FULL", hcpcs_code: "A7030" },
      { sku_prefix: "NASAL-INTERFACE", hcpcs_code: "A7034" },
      { sku_prefix: "CUSHION", hcpcs_code: "A7032" },
    ],
  });
  stage("hcpcs_codes", "select", {
    data: [
      {
        code: "A7034",
        min_interval_days: 90,
        max_quantity_per_period: 1,
        period_days: 90,
        active: true,
      },
      {
        code: "A7030",
        min_interval_days: 90,
        max_quantity_per_period: 1,
        period_days: 90,
        active: true,
      },
      {
        code: "A7032",
        min_interval_days: 15,
        max_quantity_per_period: 2,
        period_days: 30,
        active: true,
      },
    ],
  });
}
beforeEach(() => db.reset());
describe("batched patient supply review", () => {
  it("keeps overlapping SKU prefixes in their own HCPCS families", async () => {
    references();
    stage("fulfillments", "select", {
      data: [
        {
          item_sku: "MASK-FULL-L",
          quantity: 1,
          created_at: ago(1),
          shipped_at: null,
        },
      ],
    });
    const result = await loadPatientSupplySummary(
      getOrgScopedClient("org"),
      "patient",
      ["MASK-M"],
      now,
    );
    expect(result.entitlements.get("MASK-M")).toMatchObject({
      eligible: true,
      hcpcsCode: "A7034",
    });
  });
  it("counts a dispense under another SKU prefix in the same HCPCS family", async () => {
    references();
    stage("fulfillments", "select", {
      data: [
        {
          item_sku: "NASAL-INTERFACE-L",
          quantity: 1,
          created_at: ago(1),
          shipped_at: null,
        },
      ],
    });
    const result = await loadPatientSupplySummary(
      getOrgScopedClient("org"),
      "patient",
      ["MASK-M"],
      now,
    );
    expect(result.entitlements.get("MASK-M")).toMatchObject({
      eligible: false,
      status: "too_soon",
      hcpcsCode: "A7034",
    });
  });
  it("calculates multiple supplies with one shared set of reads", async () => {
    references();
    stage("fulfillments", "select", {
      data: [
        {
          item_sku: "CUSHION-M",
          quantity: 1,
          created_at: ago(20),
          shipped_at: ago(18),
        },
        {
          item_sku: "CUSHION-L",
          quantity: 1,
          created_at: ago(25),
          shipped_at: null,
        },
        {
          item_sku: "MASK-FULL-L",
          quantity: 1,
          created_at: ago(100),
          shipped_at: ago(98),
        },
      ],
    });
    const result = await loadPatientSupplySummary(
      getOrgScopedClient("org"),
      "patient",
      ["CUSHION-M", "CUSHION-L", "MASK-FULL-L", "UNMAPPED"],
      now,
    );
    expect(result.entitlements.get("CUSHION-M")).toMatchObject({
      status: "quantity_exceeded",
      eligible: false,
      hcpcsCode: "A7032",
    });
    expect(result.entitlements.get("MASK-FULL-L")).toMatchObject({
      eligible: true,
      hcpcsCode: "A7030",
      skuPrefix: "MASK-FULL",
    });
    expect(result.entitlements.get("UNMAPPED")).toBeNull();
    expect(result.lastOrderedAt.get("CUSHION-M")).toBe(ago(20));
    expect(result.lastSuppliedAt.get("CUSHION-M")).toBe(ago(18));
    for (const table of ["sku_hcpcs_map", "hcpcs_codes", "fulfillments"])
      expect(getSupabaseCallCount(table, "select")).toBe(1);
    expect(getSupabaseFilterCalls("fulfillments", "select")).toEqual(
      expect.arrayContaining([
        { verb: "eq", args: ["org_id", "org"] },
        { verb: "eq", args: ["patient_id", "patient"] },
        { verb: "neq", args: ["status", "cancelled"] },
      ]),
    );
  });
  it("includes older supplies beyond the first history page", async () => {
    references();
    stage("fulfillments", "select", {
      data: Array.from({ length: 200 }, (_, i) => ({
        item_sku: "MASK-M",
        quantity: 1,
        created_at: ago(i),
        shipped_at: null,
      })),
    });
    stage("fulfillments", "select", {
      data: [
        {
          item_sku: "CUSHION-M",
          quantity: 1,
          created_at: ago(300),
          shipped_at: ago(299),
        },
      ],
    });
    const result = await loadPatientSupplySummary(
      getOrgScopedClient("org"),
      "patient",
      ["CUSHION-M"],
      now,
    );
    expect(result.lastOrderedAt.get("CUSHION-M")).toBe(ago(300));
    expect(result.entitlements.get("CUSHION-M")?.eligible).toBe(true);
    expect(getSupabaseCallCount("fulfillments", "select")).toBe(2);
  });
  it("does not fabricate eligibility if history cannot be read", async () => {
    references();
    stage("fulfillments", "select", { error: new Error("offline") });
    await expect(
      loadPatientSupplySummary(
        getOrgScopedClient("org"),
        "patient",
        ["CUSHION-M"],
        now,
      ),
    ).rejects.toThrow("offline");
  });
});
