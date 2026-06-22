// GET /platform/margin — fleet gross-margin rollup.
//
// The margin math itself is unit-tested in @workspace/resupply-domain;
// here we cover the route contract: the gate, validation, and the
// per-tenant fold + fleet total (incl. the uncosted-revenue blind spot).

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

import marginRouter from "./margin";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(marginRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockPlatformAdmin.current = null;
});

describe("GET /platform/margin", () => {
  it("401s for a non-platform-admin", async () => {
    const res = await request(makeApp()).get("/platform/margin");
    expect(res.status).toBe(401);
  });

  it("400s on an out-of-range window", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp()).get("/platform/margin?days=9999");
    expect(res.status).toBe(400);
  });

  it("folds per-tenant COGS into a fleet rollup with the uncosted blind spot", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-1", slug: "acme", name: "Acme DME", status: "active" }],
    });
    // One costed line (qty 2 @ $50, cost $30 → margin $40 on $100 costed)
    // and one uncosted line ($20, no cost → blind spot).
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        { quantity: 2, unit_amount_cents: 5000, unit_cost_cents: 3000 },
        { quantity: 1, unit_amount_cents: 2000, unit_cost_cents: null },
      ],
    });

    const res = await request(makeApp()).get("/platform/margin?days=30");
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.fleet).toMatchObject({
      revenueCents: 12000,
      costedRevenueCents: 10000,
      uncostedRevenueCents: 2000,
      costCents: 6000,
      marginCents: 4000,
    });
    expect(res.body.fleet.marginRatio).toBeCloseTo(0.4, 5);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0]).toMatchObject({
      id: "org-1",
      slug: "acme",
      revenueCents: 12000,
      marginCents: 4000,
    });
  });
});
