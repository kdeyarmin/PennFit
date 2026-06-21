// Unit tests for autoClearBackorderForSku — the restock → backorder-clear
// loop. Exercises the org-scoped DB path via the supabase mock.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { logAuditMock } = vi.hoisted(() => ({
  logAuditMock: vi.fn(async () => undefined),
}));
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

import { autoClearBackorderForSku } from "./auto-clear-on-restock";

const ORG = "00000000-0000-4000-8000-000000000000";
const SKU = "mask-nasal-pillows-medium";

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockReset();
  logAuditMock.mockResolvedValue(undefined);
});

describe("autoClearBackorderForSku", () => {
  it("clears an open backorder for the SKU and audits it", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      data: [{ id: "bo-1", notes: "marked by csr" }],
    });
    stageSupabaseResponse("shop_backorders", "update", { data: null });

    const result = await autoClearBackorderForSku({ orgId: ORG, sku: SKU });

    expect(result.cleared).toBe(1);
    expect(supabaseMock.callCount("shop_backorders", "update")).toBe(1);
    // cleared_at stamped + an auto-clear note appended.
    const payload = supabaseMock.writePayloads(
      "shop_backorders",
      "update",
    )[0] as Record<string, unknown> | undefined;
    expect(payload?.cleared_at).toBeTruthy();
    expect(String(payload?.notes)).toContain("auto-cleared: back in stock");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0]?.[0]).toMatchObject({
      action: "resupply.backorder.cleared",
      metadata: { sku: SKU, auto: true },
    });
  });

  it("is a no-op when the SKU has no open backorder", async () => {
    stageSupabaseResponse("shop_backorders", "select", { data: [] });

    const result = await autoClearBackorderForSku({ orgId: ORG, sku: SKU });

    expect(result.cleared).toBe(0);
    expect(supabaseMock.callCount("shop_backorders", "update")).toBe(0);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("is a no-op for a blank SKU (never queries)", async () => {
    const result = await autoClearBackorderForSku({ orgId: ORG, sku: "  " });
    expect(result.cleared).toBe(0);
    expect(supabaseMock.callCount("shop_backorders", "select")).toBe(0);
  });

  it("never throws when the lookup errors (fail-soft)", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      error: { code: "08006", message: "connection terminated" },
    });

    const result = await autoClearBackorderForSku({ orgId: ORG, sku: SKU });
    expect(result.cleared).toBe(0);
  });

  it("clears every open row for the SKU", async () => {
    stageSupabaseResponse("shop_backorders", "select", {
      data: [
        { id: "bo-1", notes: null },
        { id: "bo-2", notes: null },
      ],
    });
    stageSupabaseResponse("shop_backorders", "update", { data: null });
    stageSupabaseResponse("shop_backorders", "update", { data: null });

    const result = await autoClearBackorderForSku({ orgId: ORG, sku: SKU });
    expect(result.cleared).toBe(2);
    expect(logAuditMock).toHaveBeenCalledTimes(2);
  });
});
