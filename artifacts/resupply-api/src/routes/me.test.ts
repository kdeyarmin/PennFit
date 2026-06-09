// Route test for GET /resupply-api/me — focuses on the multi-location
// (#O1) addition: the signed-in staff member's home branch is surfaced
// as `locationId` (null when unassigned) to drive the SPA's soft
// default branch filter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../middlewares/requireAdmin", () => makeRequireAdminMock(mockAdmin));
vi.mock("../middlewares/admin-rate-limit", () => ({
  adminReadRateLimiter: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
}));
const { flagState } = vi.hoisted(() => ({ flagState: { enabled: false } }));
vi.mock("../lib/feature-flags", () => ({
  isFeatureEnabled: async () => flagState.enabled,
}));

import meRouter from "./me";

const LOCATION = "99999999-9999-4999-8999-999999999999";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  flagState.enabled = false;
});

describe("GET /me — location", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get("/me");
    expect(res.status).toBe(401);
  });

  it("surfaces the assigned home branch as locationId", async () => {
    mockAdmin.current = {
      userId: "u_1",
      email: "csr@penn.example.com",
      role: "agent",
      locationId: LOCATION,
    };
    const res = await request(makeApp()).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.locationId).toBe(LOCATION);
  });

  it("returns null locationId for an unassigned staff member", async () => {
    mockAdmin.current = {
      userId: "u_2",
      email: "admin@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp()).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.locationId).toBeNull();
  });

  it("reflects the multi_location.enabled flag (off by default)", async () => {
    mockAdmin.current = {
      userId: "u_3",
      email: "admin@penn.example.com",
      role: "admin",
    };
    const off = await request(makeApp()).get("/me");
    expect(off.body.multiLocationEnabled).toBe(false);

    flagState.enabled = true;
    const on = await request(makeApp()).get("/me");
    expect(on.body.multiLocationEnabled).toBe(true);
  });
});
