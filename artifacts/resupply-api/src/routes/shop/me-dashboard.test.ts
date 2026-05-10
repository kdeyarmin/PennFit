// Route tests for /shop/me/dashboard.
//
// Coverage:
//   * 401 without sign-in
//   * Empty digest when no subs / orders / cart
//   * nextShipment.daysUntil computed against "now" (Phase A.1)
//   * eligibility.eligibleNow surfaces subs whose period has rolled past
//   * eligibility.soonest mirrors the next-future shipment

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import meDashboardRouter from "./me-dashboard";

const USER_ID = "user_abc";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meDashboardRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

// All four reads run concurrently in `Promise.all`. Stage in order.
function stageEmpty(): void {
  stageSupabaseResponse("shop_subscriptions", "select", { data: [] });
  stageSupabaseResponse("shop_orders", "select", { data: null });
  stageSupabaseResponse("shop_orders", "select", { data: null, count: 0 });
  stageSupabaseResponse("shop_abandoned_carts", "select", { data: null });
}

describe("GET /shop/me/dashboard", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns an empty digest when the customer has nothing", async () => {
    mockSignedIn.current = USER_ID;
    stageEmpty();

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      nextShipment: null,
      eligibility: { eligibleNow: [], soonest: null },
      latestOrder: null,
      activeSubscriptions: 0,
      pendingOrders: 0,
      abandonedCart: null,
    });
  });

  it("computes daysUntil + eligibleNow from active subscriptions", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2024-01-15T12:00:00.000Z");
      vi.setSystemTime(now);

      mockSignedIn.current = USER_ID;
      const inFiveDaysIso = new Date(
        now.getTime() + 5 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const yesterdayIso = new Date(
        now.getTime() - 24 * 60 * 60 * 1000,
      ).toISOString();
      stageSupabaseResponse("shop_subscriptions", "select", {
        data: [
          // Active sub eligible NOW (period rolled yesterday).
          {
            id: "sub_now",
            status: "active",
            current_period_end: yesterdayIso,
            cancel_at_period_end: false,
            items: [{ name: "Mask cushion" }],
          },
          // Active sub eligible in ~5 days — drives nextShipment.
          {
            id: "sub_soon",
            status: "active",
            current_period_end: inFiveDaysIso,
            cancel_at_period_end: false,
            items: [{ name: "Tubing" }],
          },
        ],
      });
      stageSupabaseResponse("shop_orders", "select", { data: null });
      stageSupabaseResponse("shop_orders", "select", {
        data: null,
        count: 0,
      });
      stageSupabaseResponse("shop_abandoned_carts", "select", { data: null });

      const res = await request(makeApp()).get("/shop/me/dashboard");
      expect(res.status).toBe(200);
      // Soonest future shipment is the 5-day-out tubing.
      expect(res.body.nextShipment).toMatchObject({
        subscriptionId: "sub_soon",
        firstItemName: "Tubing",
      });
      expect(res.body.nextShipment.daysUntil).toBeGreaterThanOrEqual(4);
      expect(res.body.nextShipment.daysUntil).toBeLessThanOrEqual(5);
      // Eligibility-now picks up the rolled-past mask cushion.
      expect(res.body.eligibility.eligibleNow).toEqual([
        { subscriptionId: "sub_now", firstItemName: "Mask cushion" },
      ]);
      expect(res.body.eligibility.soonest).toMatchObject({
        firstItemName: "Tubing",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes cancelAtPeriodEnd subs from eligibleNow", async () => {
    // A sub that's cancelling at period end shouldn't suggest a
    // reorder — Stripe will let it lapse rather than auto-renew.
    mockSignedIn.current = USER_ID;
    const yesterdayIso = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    stageSupabaseResponse("shop_subscriptions", "select", {
      data: [
        {
          id: "sub_cancel",
          status: "active",
          current_period_end: yesterdayIso,
          cancel_at_period_end: true,
          items: [{ name: "Mask cushion" }],
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "select", { data: null });
    stageSupabaseResponse("shop_orders", "select", { data: null, count: 0 });
    stageSupabaseResponse("shop_abandoned_carts", "select", { data: null });

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.eligibility.eligibleNow).toEqual([]);
  });
});
