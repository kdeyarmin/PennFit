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

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// Three SELECTs: subscriptions, latest order, pending count, abandoned cart.
// Plus the route reads them in this order. We push 4 results per call.
const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    };
    // Some calls await the where directly (count + cart) — make
    // .where also resolve when used as a terminal.
    (obj as { where: unknown }).where = (..._args: unknown[]) => ({
      ...obj,
      then: (resolve: (v: unknown) => void) =>
        Promise.resolve(result).then(resolve),
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    });
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

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
  selectQueue.length = 0;
});

describe("GET /shop/me/dashboard", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns an empty digest when the customer has nothing", async () => {
    mockSignedIn.current = USER_ID;
    selectQueue.push([]); // subscriptions
    selectQueue.push([]); // latest order
    selectQueue.push([{ count: 0 }]); // pending count
    selectQueue.push([]); // abandoned cart

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
    mockSignedIn.current = USER_ID;
    const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    selectQueue.push([
      // Active sub eligible NOW (period rolled yesterday).
      {
        id: "sub_now",
        status: "active",
        currentPeriodEnd: yesterday,
        cancelAtPeriodEnd: false,
        items: [{ name: "Mask cushion" }],
      },
      // Active sub eligible in ~5 days — drives nextShipment.
      {
        id: "sub_soon",
        status: "active",
        currentPeriodEnd: inFiveDays,
        cancelAtPeriodEnd: false,
        items: [{ name: "Tubing" }],
      },
    ]);
    selectQueue.push([]); // latest order
    selectQueue.push([{ count: 0 }]); // pending count
    selectQueue.push([]); // abandoned cart

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
  });

  it("excludes cancelAtPeriodEnd subs from eligibleNow", async () => {
    // A sub that's cancelling at period end shouldn't suggest a
    // reorder — Stripe will let it lapse rather than auto-renew.
    mockSignedIn.current = USER_ID;
    selectQueue.push([
      {
        id: "sub_cancel",
        status: "active",
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: true,
        items: [{ name: "Mask cushion" }],
      },
    ]);
    selectQueue.push([]); // latest order
    selectQueue.push([{ count: 0 }]); // pending count
    selectQueue.push([]); // abandoned cart

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.eligibility.eligibleNow).toEqual([]);
  });
});
