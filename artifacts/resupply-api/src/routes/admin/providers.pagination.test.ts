// Pagination contract for GET /admin/providers.
//
// The registry used to hard-cap at 50 with no total/offset, silently
// hiding overflow. It now returns { total, limit, offset, providers }
// from a windowed query so the SPA can page through.

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

import providersRouter from "./providers";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(providersRouter);
  return app;
}

const ROW = {
  id: "p1",
  npi: "1234567890",
  legal_name: "Dr A",
  taxonomy_code: null,
  phone_e164: null,
  fax_e164: null,
  email: null,
  practice_name: null,
  source: "nppes",
  verified_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  mockAdmin.current = ADMIN;
  supabaseMock.reset();
});

describe("GET /admin/providers — pagination", () => {
  it("401s without a session", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get("/admin/providers");
    expect(res.status).toBe(401);
  });

  it("returns { total, limit, offset, providers } from the paged query", async () => {
    stageSupabaseResponse("providers", "select", { data: [ROW], count: 137 });
    const res = await request(makeApp()).get(
      "/admin/providers?limit=25&offset=50",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(137);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(50);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.providers[0].legalName).toBe("Dr A");
  });

  it("clamps limit to the max and floors a bad offset to 0", async () => {
    stageSupabaseResponse("providers", "select", { data: [], count: 0 });
    const res = await request(makeApp()).get(
      "/admin/providers?limit=9999&offset=-5",
    );
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100); // MAX_LIMIT
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(0);
  });

  it("defaults to limit 50 / offset 0 when unspecified", async () => {
    stageSupabaseResponse("providers", "select", { data: [ROW], count: 1 });
    const res = await request(makeApp()).get("/admin/providers");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });
});
