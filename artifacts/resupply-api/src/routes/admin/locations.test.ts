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

import locationsRouter from "./locations";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};
const AGENT: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const LOC_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(locationsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/locations", () => {
  it("401 unauthenticated", async () => {
    expect((await request(makeApp()).get("/admin/locations")).status).toBe(401);
  });

  it("lists locations and resolves the primary", async () => {
    mockAdmin.current = AGENT; // reports.read is enough
    stageSupabaseResponse("locations", "select", {
      data: [
        { id: "a", name: "A", is_primary: false, is_active: true },
        { id: LOC_ID, name: "Main", is_primary: true, is_active: true },
      ],
    });
    const res = await request(makeApp()).get("/admin/locations");
    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(2);
    expect(res.body.primaryId).toBe(LOC_ID);
  });
});

describe("POST /admin/locations", () => {
  it("403 for a non-admin", async () => {
    mockAdmin.current = AGENT;
    const res = await request(makeApp())
      .post("/admin/locations")
      .send({ name: "Branch 2" });
    expect(res.status).toBe(403);
  });

  it("400 on a blank name", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/locations")
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("creates a location (and clears prior primary when isPrimary)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("locations", "update", { data: null }); // clearExistingPrimary
    stageSupabaseResponse("locations", "insert", { data: { id: LOC_ID } });
    const res = await request(makeApp())
      .post("/admin/locations")
      .send({ name: "HQ", isPrimary: true, city: "Phila" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(LOC_ID);
    const ins = supabaseMock.writePayloads("locations", "insert")[0] as Record<
      string,
      unknown
    >;
    expect(ins.is_primary).toBe(true);
    expect(ins.name).toBe("HQ");
  });
});

describe("PATCH /admin/locations/:id", () => {
  it("404 when the row doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("locations", "update", { data: [] });
    const res = await request(makeApp())
      .patch(`/admin/locations/${LOC_ID}`)
      .send({ isActive: false });
    expect(res.status).toBe(404);
  });

  it("updates a location for an admin", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("locations", "update", { data: [{ id: LOC_ID }] });
    const res = await request(makeApp())
      .patch(`/admin/locations/${LOC_ID}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
