import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const countPendingMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const getProductMock = vi.hoisted(() => vi.fn());
const resolveTenantBaseUrlMock = vi.hoisted(() => vi.fn());

vi.mock("../back-in-stock-record", () => ({
  countPendingBackInStock: countPendingMock,
  dispatchBackInStockForProduct: dispatchMock,
}));

vi.mock("../catalog/store", () => ({
  getProduct: getProductMock,
}));

vi.mock("../tenant-branding", () => ({
  resolveTenantBaseUrl: resolveTenantBaseUrlMock,
}));

import {
  autoDispatchBackInStockOnRestock,
  isBackInStockAutoDispatchEnabled,
} from "./auto-dispatch-on-restock";

const ORG = "00000000-0000-4000-8000-000000000000";
const SKU = "mask-nasal-pillows-medium";

describe("isBackInStockAutoDispatchEnabled", () => {
  const prev = process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH;
    } else {
      process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH = prev;
    }
  });

  it("is off unless explicitly enabled", () => {
    delete process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH;
    expect(isBackInStockAutoDispatchEnabled()).toBe(false);
    process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH = "1";
    expect(isBackInStockAutoDispatchEnabled()).toBe(true);
  });
});

describe("autoDispatchBackInStockOnRestock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH = "1";
    countPendingMock.mockResolvedValue(2);
    getProductMock.mockResolvedValue({
      sku: SKU,
      name: "Nasal Pillows Mask",
    });
    resolveTenantBaseUrlMock.mockResolvedValue("https://pennpaps.com");
    dispatchMock.mockResolvedValue({
      pending: 2,
      attempted: 2,
      delivered: 2,
      failed: 0,
    });
  });

  afterEach(() => {
    delete process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH;
  });

  it("no-ops when the env flag is off", async () => {
    delete process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH;

    const result = await autoDispatchBackInStockOnRestock({
      orgId: ORG,
      sku: SKU,
    });

    expect(result.started).toBe(false);
    expect(countPendingMock).not.toHaveBeenCalled();
  });

  it("no-ops when there are no pending signups", async () => {
    countPendingMock.mockResolvedValueOnce(0);

    const result = await autoDispatchBackInStockOnRestock({
      orgId: ORG,
      sku: SKU,
    });

    expect(result.pending).toBe(0);
    expect(result.started).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("starts dispatch with a contact CTA when signups are pending", async () => {
    const result = await autoDispatchBackInStockOnRestock({
      orgId: ORG,
      sku: SKU,
    });

    expect(result.started).toBe(true);
    expect(result.pending).toBe(2);
    expect(getProductMock).toHaveBeenCalledWith(ORG, SKU);
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        productId: SKU,
        productName: "Nasal Pillows Mask",
        productUrl: expect.stringContaining("/contact?"),
      }),
    );
    expect(String(dispatchMock.mock.calls[0]?.[0]?.productUrl)).toContain(
      encodeURIComponent(SKU),
    );
  });

  it("never throws when the pending count lookup fails", async () => {
    countPendingMock.mockRejectedValueOnce(new Error("db down"));

    const result = await autoDispatchBackInStockOnRestock({
      orgId: ORG,
      sku: SKU,
    });

    expect(result.started).toBe(false);
  });
});
