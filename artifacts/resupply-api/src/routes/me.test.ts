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
const { flagState } = vi.hoisted(() => ({
  flagState: { enabled: false, disabled: [] as string[] },
}));
vi.mock("../lib/feature-flags", () => ({
  isFeatureEnabled: async () => flagState.enabled,
  listDisabledFeatures: async () => flagState.disabled,
}));
const { scopeState } = vi.hoisted(() => ({
  scopeState: { scope: "full" as "full" | "mask_fitter" },
}));
vi.mock("../lib/product-scope", () => ({
  resolveTenantProductScope: async () => scopeState.scope,
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
  flagState.disabled = [];
  scopeState.scope = "full";
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

  it("surfaces the tenant's product scope (defaults to full)", async () => {
    mockAdmin.current = {
      userId: "u_4",
      email: "admin@penn.example.com",
      role: "admin",
    };
    const full = await request(makeApp()).get("/me");
    expect(full.body.productScope).toBe("full");

    scopeState.scope = "mask_fitter";
    const fitter = await request(makeApp()).get("/me");
    expect(fitter.body.productScope).toBe("mask_fitter");
  });
});

// App modules (migration 0488). The SPA subtracts these from the sidebar,
// so /me is the only place the console learns what to hide.
describe("GET /me — disabled features", () => {
  it("reports an empty list when nothing is switched off", async () => {
    mockAdmin.current = {
      userId: "u_1",
      email: "owner@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp()).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.disabledFeatures).toEqual([]);
  });

  it("passes the tenant's switched-off keys through verbatim", async () => {
    flagState.disabled = ["module.billing", "module.storefront"];
    mockAdmin.current = {
      userId: "u_1",
      email: "owner@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp()).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.disabledFeatures).toEqual([
      "module.billing",
      "module.storefront",
    ]);
  });
});
