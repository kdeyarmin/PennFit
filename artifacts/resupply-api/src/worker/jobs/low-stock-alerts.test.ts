// Tests for the low-stock alert dispatcher.
//
// Covers the dedup/cooldown state machine described in migration 0142 and
// the worker's own comment block:
//   * No SKUs below threshold   → resolve sweep runs but no alert sent.
//   * First-ever alert          → email goes out + state row upserted.
//   * Cooldown suppression      → a recent alert within 24h is skipped.
//   * Recovery + re-dip         → resolved row, then a later dip alerts again.
//   * No recipients             → state still upserted, nothing sent.
//   * Untracked SKUs            → never alert, never resolve.
//
// The catalog is mocked at the `listTrackedProducts` boundary (it is the
// module's whole view of stock) and email at `@workspace/resupply-email`,
// consistent with the other worker-job tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { sendEmailMock, sendgridShouldThrow, FakeEmailConfigError } = vi.hoisted(
  () => {
    class FakeEmailConfigError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "EmailConfigError";
      }
    }
    return {
      sendEmailMock: vi.fn<(args: unknown) => Promise<undefined>>(
        async () => undefined,
      ),
      sendgridShouldThrow: { current: false },
      FakeEmailConfigError,
    };
  },
);
vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  EmailConfigError: FakeEmailConfigError,
  createSendgridClient: () => {
    if (sendgridShouldThrow.current) {
      throw new FakeEmailConfigError("SENDGRID_API_KEY is required");
    }
    return { sendEmail: sendEmailMock };
  },
}));

const { listTrackedMock } = vi.hoisted(() => ({ listTrackedMock: vi.fn() }));
vi.mock("../../lib/catalog/store", () => ({
  listTrackedProducts: (orgId: string) => listTrackedMock(orgId),
}));

import { runLowStockAlerts } from "./low-stock-alerts";

/** A projected catalog row as `listTrackedProducts` returns it. */
function product(
  sku: string,
  name: string,
  stockCount: number | null,
  lowStockThreshold: number | null,
) {
  return {
    sku,
    name,
    description: null,
    category: "cushion",
    manufacturer: null,
    modelNumber: null,
    unitOfMeasure: "each",
    stockCount,
    lowStockThreshold,
    lowStock:
      stockCount !== null &&
      lowStockThreshold !== null &&
      stockCount <= lowStockThreshold,
    active: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const originalAdminEmails = process.env.RESUPPLY_ADMIN_EMAILS;
const SEED_ORG = "00000000-0000-4000-8000-000000000000";

beforeEach(() => {
  supabaseMock.reset();
  sendEmailMock.mockClear();
  listTrackedMock.mockReset().mockResolvedValue([]);
  sendgridShouldThrow.current = false;
  process.env.RESUPPLY_ADMIN_EMAILS = "ops@penn.example,owner@penn.example";
  stageSupabaseResponse("organizations", "select", {
    data: [{ id: SEED_ORG }],
  });
});

afterEach(() => {
  if (originalAdminEmails === undefined) {
    delete process.env.RESUPPLY_ADMIN_EMAILS;
  } else {
    process.env.RESUPPLY_ADMIN_EMAILS = originalAdminEmails;
  }
});

describe("runLowStockAlerts: nothing to do", () => {
  it("sends nothing when every SKU is above its reorder point", async () => {
    listTrackedMock.mockResolvedValue([
      product("MASK-1", "Mask", 50, 5),
      product("FILT-1", "Filter", 30, 5),
    ]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });

    const stats = await runLowStockAlerts();

    expect(stats.scanned).toBe(2);
    expect(stats.belowThreshold).toBe(0);
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("low_stock_alert_state", "upsert")).toBe(0);
  });

  it("ignores untracked SKUs entirely", async () => {
    // stockCount null = the tenant asked us not to count this one. It must
    // neither alert nor be swept into the recovered set (which would churn
    // alert state for a SKU that has none).
    listTrackedMock.mockResolvedValue([product("BULK-1", "Wipes", null, null)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });

    const stats = await runLowStockAlerts();

    expect(stats.belowThreshold).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("low_stock_alert_state", "upsert")).toBe(0);
  });
});

describe("runLowStockAlerts: first-ever alert", () => {
  it("emails every recipient and upserts state keyed by SKU", async () => {
    listTrackedMock.mockResolvedValue([
      product("CUSH-P10", "Pillows Cushion", 2, 5),
      product("FRAME-1", "Mask Frame", 40, 5),
    ]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();

    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(1);
    expect(stats.emailSent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);

    const upserts = getSupabaseWritePayloads("low_stock_alert_state", "upsert");
    const rows = (upserts.flat() as Array<{ product_id: string }>).flat();
    // The state table's column is still `product_id`; it now carries the SKU.
    expect(rows.map((r) => r.product_id)).toEqual(["CUSH-P10"]);
  });

  it("alerts AT the reorder point, not only below it", async () => {
    listTrackedMock.mockResolvedValue([product("CUSH-P10", "Cushion", 5, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    expect(stats.newAlerts).toBe(1);
  });
});

describe("runLowStockAlerts: cooldown + recovery", () => {
  it("suppresses a SKU alerted within the cooldown window", async () => {
    listTrackedMock.mockResolvedValue([product("CUSH-P10", "Cushion", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "CUSH-P10",
          last_alerted_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          last_resolved_at: null,
        },
      ],
    });

    const stats = await runLowStockAlerts();

    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(0);
    expect(stats.cooldownSkipped).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("re-alerts once the cooldown has expired", async () => {
    listTrackedMock.mockResolvedValue([product("CUSH-P10", "Cushion", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "CUSH-P10",
          last_alerted_at: new Date(
            Date.now() - 48 * 60 * 60 * 1000,
          ).toISOString(),
          last_resolved_at: null,
        },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    expect(stats.newAlerts).toBe(1);
    expect(stats.cooldownSkipped).toBe(0);
  });

  it("treats a dip after a recovery as a fresh alert, ignoring cooldown", async () => {
    const alertedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const resolvedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    listTrackedMock.mockResolvedValue([product("CUSH-P10", "Cushion", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "CUSH-P10",
          last_alerted_at: alertedAt,
          last_resolved_at: resolvedAt,
        },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    // Resolved AFTER the last alert → a new dip, so it alerts even though
    // the 24h cooldown has not elapsed.
    expect(stats.newAlerts).toBe(1);
    expect(stats.cooldownSkipped).toBe(0);
  });

  it("stamps recovery for SKUs that climbed back above their point", async () => {
    listTrackedMock.mockResolvedValue([product("CUSH-P10", "Cushion", 40, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", {
      data: [{ product_id: "CUSH-P10" }],
    });

    const stats = await runLowStockAlerts();
    expect(stats.resolved).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("runLowStockAlerts: delivery guards", () => {
  it("still records state when there is nobody to email", async () => {
    delete process.env.RESUPPLY_ADMIN_EMAILS;
    listTrackedMock.mockResolvedValue([product("CUSH-P10", "Cushion", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });
    stageSupabaseResponse("admin_users", "select", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();

    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Upserting anyway stops the job recomputing the same alertable set
    // every 6h without ever delivering it.
    expect(
      getSupabaseCallCount("low_stock_alert_state", "upsert"),
    ).toBeGreaterThan(0);
  });

  it("skips the send when email is unconfigured", async () => {
    sendgridShouldThrow.current = true;
    listTrackedMock.mockResolvedValue([product("CUSH-P10", "Cushion", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });

    const stats = await runLowStockAlerts();
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("runLowStockAlerts: tenant isolation", () => {
  it("reads each tenant's own catalog", async () => {
    const ORG_B = "11111111-1111-4111-8111-111111111111";
    supabaseMock.reset();
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: SEED_ORG }, { id: ORG_B }],
    });
    listTrackedMock.mockResolvedValue([]);

    await runLowStockAlerts();

    // One org-scoped catalog read per active tenant — never a shared list.
    expect(listTrackedMock.mock.calls.map((c) => c[0])).toEqual([
      SEED_ORG,
      ORG_B,
    ]);
  });
});
