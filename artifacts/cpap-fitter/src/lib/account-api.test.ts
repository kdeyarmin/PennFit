import { describe, expect, test, vi } from "vitest";

import {
  cancelShopSubscription,
  fetchShopMySubscriptions,
  openBillingPortal,
  startQuickCheckout,
} from "./account-api";

describe("openBillingPortal", () => {
  test("throws billing_portal_retired without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(openBillingPortal()).rejects.toThrow(/billing_portal_retired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("startQuickCheckout", () => {
  test("throws quick_checkout_retired without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      startQuickCheckout({
        items: [{ priceId: "price_x", quantity: 1 }],
      }),
    ).rejects.toThrow(/quick_checkout_retired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("retired subscription client helpers", () => {
  test("fetchShopMySubscriptions throws without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchShopMySubscriptions()).rejects.toThrow(
      /subscriptions_retired/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("cancelShopSubscription throws without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(cancelShopSubscription("sub_1")).rejects.toThrow(
      /subscriptions_retired/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
