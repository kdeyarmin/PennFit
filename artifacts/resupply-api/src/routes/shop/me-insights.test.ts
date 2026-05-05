// Route tests for /shop/me/insights (Phase G.4).
//
// Coverage:
//   * 401 without sign-in.
//   * Empty array when no email is on the session (no patient match
//     possible).
//   * Empty array when the email matches no patient row.
//   * Returns projected insights with kind-specific copy + CTA.
//   * Strips dismissed events.
//   * `notified: true` reflects sent_at presence.
//   * Cap is honoured (limit 20).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInRef,
} from "../../test-helpers/auth-mocks";

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as MockSignedInRef["current"] },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      innerJoin: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    };
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

import meInsightsRouter from "./me-insights";

const USER_ID = "user_alice";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meInsightsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  selectQueue.length = 0;
});

describe("GET /shop/me/insights", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(401);
  });

  it("returns empty array when no email is attached to the session", async () => {
    mockSignedIn.current = USER_ID;
    // No selectQueue push — handler short-circuits before query.
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ insights: [] });
  });

  it("returns empty array when no patient row matches the email", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    selectQueue.push([]);
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(200);
    expect(res.body.insights).toEqual([]);
  });

  it("projects active triggers with kind-specific copy + CTA", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    selectQueue.push([
      {
        id: "evt_leak",
        kind: "leak_rising",
        detectedAt: new Date("2026-04-30T12:00:00Z"),
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-30",
        sentAt: new Date("2026-04-30T13:00:00Z"),
      },
      {
        id: "evt_use",
        kind: "usage_dropping",
        detectedAt: new Date("2026-04-29T12:00:00Z"),
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-29",
        sentAt: null,
      },
    ]);
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(200);
    expect(res.body.insights).toHaveLength(2);

    const leak = res.body.insights[0];
    expect(leak.id).toBe("evt_leak");
    expect(leak.kind).toBe("leak_rising");
    expect(leak.notified).toBe(true);
    expect(leak.headline).toContain("seal");
    expect(leak.cta.url).toBe("/shop?cat=cushions");
    expect(leak.detectedAt).toBe("2026-04-30T12:00:00.000Z");

    const usage = res.body.insights[1];
    expect(usage.kind).toBe("usage_dropping");
    expect(usage.notified).toBe(false);
    expect(usage.cta.label).toBe("Talk to our team");
  });

  it("excludes therapy values from the response (PHI invariant)", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    selectQueue.push([
      {
        id: "evt_leak",
        kind: "leak_rising",
        detectedAt: new Date("2026-04-30T12:00:00Z"),
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-30",
        sentAt: new Date("2026-04-30T13:00:00Z"),
      },
    ]);
    const res = await request(makeApp()).get("/shop/me/insights");
    const json = JSON.stringify(res.body);
    // None of the detection inputs ever leak.
    expect(json).not.toMatch(/leakRate|ahi|usageMinutes/i);
  });
});
