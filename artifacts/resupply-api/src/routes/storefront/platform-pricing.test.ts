// Tests for GET /api/platform/pricing — the PUBLIC marketing catalog.
//
// Contract: no auth required; returns public + custom plans and active
// add-ons mapped to camelCase; never leaks Stripe ids or internal flags;
// fail-soft to an empty catalog (still 200) on a DB error.

import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import platformPricingRouter from "./platform-pricing";

function makeApp(): Express {
  const app = express();
  app.use(platformPricingRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
});

const PLAN_ROW = {
  code: "growth",
  name: "Growth",
  description: "Mid tier",
  monthly_price_cents: 189900,
  onboarding_fee_cents: 500000,
  is_public: true,
  is_custom: false,
  allowances: { seats: 15 },
  features: ["campaigns"],
  sort_order: 2,
  // Internal fields that must NOT appear in the public response.
  stripe_product_id: "prod_x",
  stripe_price_id: "price_x",
};

const ADDON_ROW = {
  code: "additional_seat",
  name: "Additional staff seat",
  category: "capacity",
  description: "Per seat",
  recurring_price_cents: 4900,
  one_time_min_cents: null,
  one_time_max_cents: null,
  unit_label: "user/month",
  sort_order: 1,
  stripe_price_id: "price_a",
};

describe("GET /api/platform/pricing", () => {
  it("returns mapped public plans + add-ons with a cache header", async () => {
    stageSupabaseResponse("billing_plans", "select", { data: [PLAN_ROW] });
    stageSupabaseResponse("billing_addons", "select", { data: [ADDON_ROW] });

    const res = await request(makeApp()).get("/platform/pricing");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("max-age=300");
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]).toMatchObject({
      code: "growth",
      name: "Growth",
      monthlyPriceCents: 189900,
      onboardingFeeCents: 500000,
      isCustom: false,
    });
    expect(res.body.addons[0]).toMatchObject({
      code: "additional_seat",
      recurringPriceCents: 4900,
      unitLabel: "user/month",
    });
  });

  it("nulls concrete pricing for custom/Enterprise tiers", async () => {
    stageSupabaseResponse("billing_plans", "select", {
      data: [
        {
          ...PLAN_ROW,
          code: "enterprise",
          name: "Enterprise",
          is_custom: true,
          monthly_price_cents: 750000,
          onboarding_fee_cents: 250000,
        },
      ],
    });
    stageSupabaseResponse("billing_addons", "select", { data: [] });

    const res = await request(makeApp()).get("/platform/pricing");
    expect(res.status).toBe(200);
    expect(res.body.plans[0]).toMatchObject({
      code: "enterprise",
      isCustom: true,
      monthlyPriceCents: null,
      onboardingFeeCents: null,
    });
    // The negotiated amount must not appear anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain("750000");
  });

  it("never leaks Stripe ids or internal flags", async () => {
    stageSupabaseResponse("billing_plans", "select", { data: [PLAN_ROW] });
    stageSupabaseResponse("billing_addons", "select", { data: [ADDON_ROW] });

    const res = await request(makeApp()).get("/platform/pricing");
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain("prod_x");
    expect(blob).not.toContain("price_x");
    expect(blob).not.toContain("price_a");
    expect(blob).not.toContain("stripe");
  });

  it("fail-soft: returns an empty catalog (200) when the read errors", async () => {
    stageSupabaseResponse("billing_plans", "select", {
      error: { message: "boom" },
    });
    stageSupabaseResponse("billing_addons", "select", { data: [] });

    const res = await request(makeApp()).get("/platform/pricing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plans: [], addons: [] });
  });
});
