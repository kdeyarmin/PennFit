// Runtime tests for the platform catalog-pricing edit endpoints:
//   PUT /platform/billing/catalog/plans/:code
//   PUT /platform/billing/catalog/addons/:code
//
// The platform-admin gate and the Stripe sync are mocked (each has its own
// coverage); this focuses on the validation + DB-patch + Stripe-reprice
// contract over the staged Supabase mock. The key behaviour: a monthly /
// recurring price change clears the stored (immutable) Stripe price id and
// triggers a catalog re-sync, while a cosmetic-only edit does neither.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

const { syncCatalogMock } = vi.hoisted(() => ({
  syncCatalogMock: vi.fn(async () => ({
    stripeConfigured: true,
    catalog: { plans: 1, addons: 0 },
  })),
}));
vi.mock("../../lib/platform-billing/stripe", () => ({
  syncPlatformBillingCatalogToStripe: syncCatalogMock,
  ensureTenantStripeCustomer: vi.fn(),
  syncTenantStripeSubscription: vi.fn(),
  PlatformBillingAccountChangedError: class extends Error {},
}));

import billingRouter from "./billing";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingRouter);
  return app;
}

function planRow(over: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    code: "growth",
    name: "Growth",
    description: "Mid tier",
    monthly_price_cents: 189900,
    onboarding_fee_cents: 500000,
    is_public: true,
    is_custom: false,
    sort_order: 2,
    allowances: { seats: 15 },
    features: ["campaigns"],
    stripe_product_id: "prod_1",
    stripe_price_id: "price_1",
    stripe_synced_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function addonRow(over: Record<string, unknown> = {}) {
  return {
    id: "addon-1",
    code: "additional_seat",
    name: "Additional staff seat",
    category: "capacity",
    description: "Per seat",
    recurring_price_cents: 4900,
    one_time_min_cents: null,
    one_time_max_cents: null,
    unit_label: "user/month",
    usage_metric: "seats",
    pass_through_note: null,
    is_active: true,
    sort_order: 1,
    stripe_product_id: "prod_a",
    stripe_price_id: "price_a",
    stripe_synced_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  syncCatalogMock.mockClear();
  mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
});

describe("PUT /platform/billing/catalog/plans/:code", () => {
  it("401s without a platform admin", async () => {
    mockPlatformAdmin.current = null;
    const res = await request(makeApp())
      .put("/platform/billing/catalog/plans/growth")
      .send({ monthlyPriceCents: 99900 });
    expect(res.status).toBe(401);
  });

  it("400s on an invalid price", async () => {
    const res = await request(makeApp())
      .put("/platform/billing/catalog/plans/growth")
      .send({ monthlyPriceCents: -5 });
    expect(res.status).toBe(400);
  });

  it("404s when the plan code is unknown", async () => {
    stageSupabaseResponse("billing_plans", "select", { data: null });
    const res = await request(makeApp())
      .put("/platform/billing/catalog/plans/nope")
      .send({ monthlyPriceCents: 99900 });
    expect(res.status).toBe(404);
  });

  it("updates the price, clears the stale Stripe price id, and re-syncs Stripe", async () => {
    stageSupabaseResponse("billing_plans", "select", { data: planRow() });
    stageSupabaseResponse("billing_plans", "update", { error: null });
    // catalog() re-read
    stageSupabaseResponse("billing_plans", "select", {
      data: [planRow({ monthly_price_cents: 99900, stripe_price_id: null })],
    });
    stageSupabaseResponse("billing_addons", "select", { data: [] });

    const res = await request(makeApp())
      .put("/platform/billing/catalog/plans/growth")
      .send({ monthlyPriceCents: 99900 });

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].monthlyPriceCents).toBe(99900);

    // The price changed → the update nulls the immutable Stripe price id
    // and a catalog re-sync is triggered.
    const updates = supabaseMock.writePayloads("billing_plans", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      monthly_price_cents: 99900,
      stripe_price_id: null,
      stripe_synced_at: null,
    });
    expect(syncCatalogMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT reprice Stripe on a cosmetic-only edit", async () => {
    stageSupabaseResponse("billing_plans", "select", { data: planRow() });
    stageSupabaseResponse("billing_plans", "update", { error: null });
    stageSupabaseResponse("billing_plans", "select", { data: [planRow()] });
    stageSupabaseResponse("billing_addons", "select", { data: [] });

    const res = await request(makeApp())
      .put("/platform/billing/catalog/plans/growth")
      .send({ name: "Growth Plus" });

    expect(res.status).toBe(200);
    const updates = supabaseMock.writePayloads("billing_plans", "update");
    expect(updates[0]).toMatchObject({ name: "Growth Plus" });
    expect(updates[0]).not.toHaveProperty("stripe_price_id");
    expect(syncCatalogMock).not.toHaveBeenCalled();
  });
});

describe("PUT /platform/billing/catalog/addons/:code", () => {
  it("repricing an add-on clears its Stripe price id and re-syncs", async () => {
    stageSupabaseResponse("billing_addons", "select", { data: addonRow() });
    stageSupabaseResponse("billing_addons", "update", { error: null });
    // catalog() re-read
    stageSupabaseResponse("billing_plans", "select", { data: [] });
    stageSupabaseResponse("billing_addons", "select", {
      data: [addonRow({ recurring_price_cents: 5900, stripe_price_id: null })],
    });

    const res = await request(makeApp())
      .put("/platform/billing/catalog/addons/additional_seat")
      .send({ recurringPriceCents: 5900 });

    expect(res.status).toBe(200);
    const updates = supabaseMock.writePayloads("billing_addons", "update");
    expect(updates[0]).toMatchObject({
      recurring_price_cents: 5900,
      stripe_price_id: null,
      stripe_synced_at: null,
    });
    expect(syncCatalogMock).toHaveBeenCalledTimes(1);
  });

  it("404s when the add-on code is unknown", async () => {
    stageSupabaseResponse("billing_addons", "select", { data: null });
    const res = await request(makeApp())
      .put("/platform/billing/catalog/addons/nope")
      .send({ recurringPriceCents: 100 });
    expect(res.status).toBe(404);
  });
});
