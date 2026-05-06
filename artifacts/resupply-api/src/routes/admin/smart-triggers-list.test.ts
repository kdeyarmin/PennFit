// Route tests for GET /admin/patients/:id/smart-triggers (Phase G.19).
//
// Coverage:
//   * 401 without admin
//   * 404 on non-UUID id (consistent with sibling /admin/patients/:id/* routes)
//   * empty events array when patient has no triggers
//   * projection shape: ISO timestamps, lifecycle fields preserved
//   * PHI invariant: therapy values never leak into the response

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    if (selectQueue.length === 0) {
      throw new Error(
        "smart-triggers-list test: selectQueue exhausted — the route made " +
          "more SELECT calls than the test scripted answers for. " +
          "Add a selectQueue.push() entry for the new query.",
      );
    }
    const result = selectQueue.shift()!;
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  selectDistinct: vi.fn(() => {
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve([]),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const obj: Record<string, unknown> = {
      values: () => obj,
      onConflictDoNothing: () => obj,
      returning: () => Promise.resolve([]),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => Promise.resolve(),
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

import smartTriggersRouter from "./smart-triggers";

const ADMIN_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-2222-3333-4444-555555555555";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(smartTriggersRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
});

describe("GET /admin/patients/:id/smart-triggers", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/smart-triggers`,
    );
    expect(res.status).toBe(401);
  });

  it("404s on non-UUID patient id", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    const res = await request(makeApp()).get(
      "/admin/patients/not-a-uuid/smart-triggers",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns empty array when patient has no triggers", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/smart-triggers`,
    );
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it("projects rows with ISO timestamps + lifecycle fields", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([
      {
        id: "evt_sent",
        kind: "leak_rising",
        detectedAt: new Date("2026-04-30T12:00:00Z"),
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-30",
        sentAt: new Date("2026-04-30T13:00:00Z"),
        dismissedAt: null,
        dismissedByEmail: null,
        dismissedReason: null,
        createdAt: new Date("2026-04-30T12:00:00Z"),
      },
      {
        id: "evt_dismissed",
        kind: "cushion_wear",
        detectedAt: new Date("2026-04-29T12:00:00Z"),
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-29",
        sentAt: null,
        dismissedAt: new Date("2026-04-29T15:00:00Z"),
        dismissedByEmail: "csr@x",
        dismissedReason: "patient called and resolved on call",
        createdAt: new Date("2026-04-29T12:00:00Z"),
      },
    ]);
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/smart-triggers`,
    );
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);

    const sent = res.body.events[0];
    expect(sent.id).toBe("evt_sent");
    expect(sent.kind).toBe("leak_rising");
    expect(sent.detectedAt).toBe("2026-04-30T12:00:00.000Z");
    expect(sent.sentAt).toBe("2026-04-30T13:00:00.000Z");
    expect(sent.dismissedAt).toBeNull();

    const dismissed = res.body.events[1];
    expect(dismissed.dismissedAt).toBe("2026-04-29T15:00:00.000Z");
    expect(dismissed.dismissedByEmail).toBe("csr@x");
    expect(dismissed.dismissedReason).toBe(
      "patient called and resolved on call",
    );
  });

  it("PHI invariant — therapy values never appear in the response", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([
      {
        id: "evt_phi",
        kind: "leak_rising",
        detectedAt: new Date("2026-04-30T12:00:00Z"),
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-30",
        sentAt: null,
        dismissedAt: null,
        dismissedByEmail: null,
        dismissedReason: null,
        createdAt: new Date("2026-04-30T12:00:00Z"),
      },
    ]);
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/smart-triggers`,
    );
    const json = JSON.stringify(res.body);
    // The detection inputs (leak rate, AHI, usage) live in
    // patient_therapy_nights and must never appear here — only kind,
    // window dates, lifecycle timestamps.
    expect(json).not.toMatch(/leakRate|ahi|usageMinutes/i);
  });
});
