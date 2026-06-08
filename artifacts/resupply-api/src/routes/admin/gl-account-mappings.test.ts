import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import glRouter from "./gl-account-mappings";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(glRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/billing/gl-account-mappings", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp()).get(
      "/admin/billing/gl-account-mappings",
    );
    expect(res.status).toBe(401);
  });

  it("returns resolved accounts marking custom vs default", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("gl_account_mappings", "select", {
      data: [{ mapping_key: "deposit", account_name: "Bank:Stripe" }],
    });
    const res = await request(makeApp()).get(
      "/admin/billing/gl-account-mappings",
    );
    expect(res.status).toBe(200);
    const deposit = res.body.accounts.find(
      (a: { key: string }) => a.key === "deposit",
    );
    expect(deposit.accountName).toBe("Bank:Stripe");
    expect(deposit.isCustom).toBe(true);
    const revenue = res.body.accounts.find(
      (a: { key: string }) => a.key === "revenue",
    );
    expect(revenue.accountName).toBe("Sales:Online Orders");
    expect(revenue.isCustom).toBe(false);
  });
});

describe("PUT /admin/billing/gl-account-mappings/:key", () => {
  it("403 for a CSR (needs cost.write)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .put("/admin/billing/gl-account-mappings/deposit")
      .send({ accountName: "Bank:Stripe" });
    expect(res.status).toBe(403);
  });

  it("404 for an unknown mapping key", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .put("/admin/billing/gl-account-mappings/bogus")
      .send({ accountName: "X" });
    expect(res.status).toBe(404);
  });

  it("upserts a mapping for an admin", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("gl_account_mappings", "upsert", { data: null });
    const res = await request(makeApp())
      .put("/admin/billing/gl-account-mappings/patient_pay")
      .send({ accountName: "Income:Patient Pay" });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe("patient_pay");
    const w = supabaseMock.writePayloads(
      "gl_account_mappings",
      "upsert",
    )[0] as Record<string, unknown>;
    expect(w.mapping_key).toBe("patient_pay");
    expect(w.account_name).toBe("Income:Patient Pay");
  });
});
