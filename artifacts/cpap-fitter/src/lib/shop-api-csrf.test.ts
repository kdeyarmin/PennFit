// Cash-pay order mutations were retired with the insurance-only cutover.
// These helpers must throw without hitting the network so a reintroduced
// UI cannot 404 silently — same posture as subscriptions / quick checkout.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelOrder,
  fetchMyOrders,
  resendOrderReceipt,
  updateOrderShippingAddress,
} from "./shop-api";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("retired cash-pay shop-api order helpers", () => {
  it("fetchMyOrders throws without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchMyOrders()).rejects.toThrow(/cash_pay_orders_retired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resendOrderReceipt throws without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(resendOrderReceipt("cs_test_123")).rejects.toThrow(
      /cash_pay_orders_retired/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updateOrderShippingAddress throws without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      updateOrderShippingAddress("o1", {
        name: "Pat Example",
        line1: "1 Main St",
        city: "Philadelphia",
        state: "PA",
        postalCode: "19103",
        country: "US",
      } as Parameters<typeof updateOrderShippingAddress>[1]),
    ).rejects.toThrow(/cash_pay_orders_retired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancelOrder throws without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(cancelOrder("o1")).rejects.toThrow(/cash_pay_orders_retired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
