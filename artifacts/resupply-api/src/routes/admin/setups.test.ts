import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import { installSupabaseMock } from "../../test-helpers/supabase-mock";

installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import setupsRouter from "./setups";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(setupsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = ADMIN;
});

afterEach(() => {
  mockAdmin.current = null;
});

describe("GET /admin/setups", () => {
  it("refuses a signed-out caller", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get("/admin/setups");
    expect(res.status).toBe(401);
  });

  it("returns an empty board when nothing is open", async () => {
    const res = await request(makeApp()).get("/admin/setups");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.morning).toEqual({
      openReferralReviews: 0,
      staleFitRequests: 0,
      unsignedPackets: 0,
      priorAuthsInSla: 0,
    });
  });
});
