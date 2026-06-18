import { ApiError } from "@workspace/api-client-react/admin";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  buildPreviewConfirm,
  fetchPlatformBillingActivity,
  fetchPlatformBillingCatalog,
  fetchPlatformTenantBilling,
  ensureTenantStripeCustomer,
  fetchTenantBilling,
  formatMoney,
  previewOwnBillingChange,
  previewTenantBillingChange,
  recordTenantUsage,
  resyncTenantStripeSubscriptions,
  syncPlatformBillingCatalogToStripe,
  syncTenantStripeSubscription,
  updateCatalogAddon,
  updateCatalogPlan,
  updateTenantAddon,
  updateTenantPlan,
  type BillingPreview,
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

  test("previewOwnBillingChange posts the change to the tenant preview endpoint", async () => {
    fetchMock.mockResolvedValue(okJson({ changeLabel: "Switch to Growth" }));

    await previewOwnBillingChange({ kind: "plan", planCode: "growth" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/preview");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "plan",
      planCode: "growth",
    });
  });

  test("previewTenantBillingChange URL-encodes the tenant id", async () => {
    fetchMock.mockResolvedValue(okJson({ changeLabel: "Set fax ×2" }));

    await previewTenantBillingChange("tenant 1", {
      kind: "addon",
      addonCode: "extra_fax",
      quantity: 2,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/platform/billing/tenants/tenant%201/preview",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "addon",
      addonCode: "extra_fax",
      quantity: 2,
    });
  });

  test("fetchPlatformBillingActivity reads the activity feed with a limit", async () => {
    fetchMock.mockResolvedValue(okJson({ activity: [] }));

    await fetchPlatformBillingActivity(10);

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/activity?limit=10",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("fetchPlatformBillingActivity scopes the feed to a tenant when given", async () => {
    fetchMock.mockResolvedValue(okJson({ activity: [] }));

    await fetchPlatformBillingActivity(10, "org-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "/resupply-api/platform/billing/activity?limit=10&tenantId=org-123",
      expect.objectContaining({ credentials: "include" }),
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

describe("buildPreviewConfirm", () => {
  const base: BillingPreview = {
    currentMonthlyCents: 19900,
    newMonthlyCents: 29900,
    deltaMonthlyCents: 10000,
    proratedNowCents: 5000,
    daysRemaining: 15,
    periodDays: 30,
    currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    changeLabel: "Switch to Growth",
  };

  test("shows the change label, monthly delta, and prorated charge", () => {
    const msg = buildPreviewConfirm(base);
    expect(msg).toContain("Switch to Growth?");
    expect(msg).toContain("New monthly total: $299/mo");
    expect(msg).toContain("+$100/mo vs. today");
    expect(msg).toContain("prorated charge");
    expect(msg).toContain("~$50");
  });

  test("renders a prorated credit for a downgrade", () => {
    const msg = buildPreviewConfirm({
      ...base,
      changeLabel: "Switch to Launch",
      newMonthlyCents: 9900,
      deltaMonthlyCents: -10000,
      proratedNowCents: -5000,
    });
    expect(msg).toContain("−$100/mo vs. today");
    expect(msg).toContain("prorated credit");
    expect(msg).toContain("~$50");
  });

  test("notes Stripe will calculate proration when the period is unknown", () => {
    const msg = buildPreviewConfirm({
      ...base,
      proratedNowCents: null,
      daysRemaining: null,
      periodDays: null,
      currentPeriodEnd: null,
    });
    expect(msg).toContain("calculated by Stripe");
  });
});
