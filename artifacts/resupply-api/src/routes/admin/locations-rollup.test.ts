// Route test for GET /admin/locations/rollup — per-branch patient +
// staff counts (multi-location #O1 phase 4). The aggregate comes from
// the location_rollup() RPC; the route merges branch names from
// `locations` and exposes the NULL-location_id row as `unassigned`.

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
  stageSupabaseRpcResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: vi.fn() }));

import locationsRouter from "./locations";

const PGH = "11111111-1111-4111-8111-111111111111";
const ERI = "22222222-2222-4222-8222-222222222222";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(locationsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = ADMIN;
  supabaseMock.reset();
});

describe("GET /admin/locations/rollup", () => {
  it("401s without admin", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get("/admin/locations/rollup");
    expect(res.status).toBe(401);
  });

  it("merges branch names with RPC counts and exposes the unassigned bucket", async () => {
    stageSupabaseResponse("locations", "select", {
      data: [
        { id: PGH, name: "Pittsburgh", is_active: true },
        { id: ERI, name: "Erie", is_active: false },
      ],
    });
    // bigint columns come back as strings over PostgREST — the route
    // coerces with Number().
    stageSupabaseRpcResponse("location_rollup", {
      data: [
        {
          location_id: PGH,
          patient_count: "12",
          active_patient_count: "9",
          staff_count: "3",
        },
        {
          location_id: null,
          patient_count: "5",
          active_patient_count: "4",
          staff_count: "1",
        },
        // Erie has staff but no patients — still surfaces via the name merge.
        {
          location_id: ERI,
          patient_count: "0",
          active_patient_count: "0",
          staff_count: "2",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/locations/rollup");
    expect(res.status).toBe(200);

    expect(res.body.branches).toHaveLength(2);
    const pgh = res.body.branches.find(
      (b: { locationId: string }) => b.locationId === PGH,
    );
    expect(pgh).toMatchObject({
      name: "Pittsburgh",
      isActive: true,
      patientCount: 12,
      activePatientCount: 9,
      staffCount: 3,
    });
    const eri = res.body.branches.find(
      (b: { locationId: string }) => b.locationId === ERI,
    );
    expect(eri).toMatchObject({ name: "Erie", patientCount: 0, staffCount: 2 });

    expect(res.body.unassigned).toEqual({
      patientCount: 5,
      activePatientCount: 4,
      staffCount: 1,
    });
  });

  it("zero-fills a branch with no rollup row", async () => {
    stageSupabaseResponse("locations", "select", {
      data: [{ id: PGH, name: "Pittsburgh", is_active: true }],
    });
    stageSupabaseRpcResponse("location_rollup", { data: [] });

    const res = await request(makeApp()).get("/admin/locations/rollup");
    expect(res.status).toBe(200);
    expect(res.body.branches[0]).toMatchObject({
      patientCount: 0,
      activePatientCount: 0,
      staffCount: 0,
    });
    expect(res.body.unassigned).toEqual({
      patientCount: 0,
      activePatientCount: 0,
      staffCount: 0,
    });
  });
});
