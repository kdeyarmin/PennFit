import { ApiError } from "@workspace/api-client-react/admin";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  fetchPlatformBillingCatalog,
  fetchPlatformTenantBilling,
  ensureTenantStripeCustomer,
  fetchTenantBilling,
  formatMoney,
  recordTenantUsage,
  resyncTenantStripeSubscriptions,
  syncPlatformBillingCatalogToStripe,
  syncTenantStripeSubscription,
  updateCatalogAddon,
  updateCatalogPlan,
  updateTenantAddon,
  updateTenantPlan,
} from "./platform-billing-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function okJson(body: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function errorJson(status: number, body: unknown): Partial<Response> {
  return {
    ok: false,
    status,
    statusText: "Nope",
    json: async () => body,
  };
}

describe("platform-billing-api", () => {
  test("fetchTenantBilling reads the tenant package endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ tenantId: "tenant-1" }));

    await fetchTenantBilling();

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/admin/billing/package",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("fetchPlatformBillingCatalog reads the super-admin catalog endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ plans: [], addons: [] }));

    await fetchPlatformBillingCatalog();

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/catalog",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("fetchPlatformTenantBilling reads the super-admin tenant billing list", async () => {
    fetchMock.mockResolvedValue(okJson({ tenants: [] }));

    await fetchPlatformTenantBilling();

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/tenants",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("updateCatalogPlan PUTs the catalog plan edit endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ plans: [], addons: [] }));

    await updateCatalogPlan("growth", { monthlyPriceCents: 99900 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/platform/billing/catalog/plans/growth");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      monthlyPriceCents: 99900,
    });
  });

  test("updateCatalogAddon PUTs the catalog add-on edit endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ plans: [], addons: [] }));

    await updateCatalogAddon("additional_seat", { recurringPriceCents: 5900 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/platform/billing/catalog/addons/additional_seat",
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      recurringPriceCents: 5900,
    });
  });

  test("resyncTenantStripeSubscriptions POSTs the fleet resync endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ total: 2, synced: 2, failed: 0 }));

    await resyncTenantStripeSubscriptions();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/platform/billing/tenants/resync-stripe");
    expect(init.method).toBe("POST");
  });

  test("updateTenantPlan URL-encodes tenant IDs and sends JSON", async () => {
    fetchMock.mockResolvedValue(okJson({ tenantId: "tenant 1" }));

    await updateTenantPlan("tenant 1", {
      planCode: "growth",
      status: "active",
      customMonthlyPriceCents: 29900,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/platform/billing/tenants/tenant%201/subscription",
    );
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      planCode: "growth",
      status: "active",
      customMonthlyPriceCents: 29900,
    });
  });

  test("updateTenantAddon saves add-on quantity changes", async () => {
    fetchMock.mockResolvedValue(okJson({ tenantId: "tenant-1" }));

    await updateTenantAddon("tenant-1", {
      addonCode: "extra_admin_seats",
      quantity: 3,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/platform/billing/tenants/tenant-1/addons");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      addonCode: "extra_admin_seats",
      quantity: 3,
    });
  });

  test("syncPlatformBillingCatalogToStripe posts to the catalog sync endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ stripeConfigured: true }));

    await syncPlatformBillingCatalogToStripe();

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/catalog/stripe/sync",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("ensureTenantStripeCustomer posts to the customer sync endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ tenantId: "tenant-1" }));

    await ensureTenantStripeCustomer("tenant-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/tenants/tenant-1/stripe/customer",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("syncTenantStripeSubscription posts to the subscription sync endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ tenantId: "tenant-1" }));

    await syncTenantStripeSubscription("tenant-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/tenants/tenant-1/stripe/subscription",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("recordTenantUsage uses the tenant-admin endpoint without tenantId", async () => {
    fetchMock.mockResolvedValue(okJson({ id: "event-1" }));

    await recordTenantUsage({ metricKey: "sms_segments", quantity: 5 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/admin/billing/usage-events",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("recordTenantUsage uses the platform endpoint when tenantId is present", async () => {
    fetchMock.mockResolvedValue(okJson({ id: "event-1" }));

    await recordTenantUsage({
      tenantId: "tenant-1",
      metricKey: "ai_document_pages",
      quantity: 12,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/usage-events",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("throws ApiError with parsed server details for non-OK responses", async () => {
    fetchMock.mockResolvedValue(
      errorJson(403, { error: "platform_admin_required" }),
    );

    const err = await fetchPlatformBillingCatalog().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});

describe("formatMoney", () => {
  test("formats whole-dollar cents", () => {
    expect(formatMoney(29900)).toBe("$299");
  });

  test("labels null prices as custom", () => {
    expect(formatMoney(null)).toBe("Custom");
  });
});
