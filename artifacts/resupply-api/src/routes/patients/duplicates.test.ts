// Route test for GET /patients/duplicates (CSR #C1, detection half).
//
// The grouping/HAVING runs in the resupply.patient_duplicate_groups RPC
// (migration 0223). The route's job is: call the RPC, fold the flat
// (group_key, patient) rows into groups, and shape the response. This
// pins that folding + the PHI posture (no phone/email values, just
// hasPhone/hasEmail markers passed through from the RPC).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseRpcResponse,
  getSupabaseRpcCallCount,
  getSupabaseRpcArgs,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import duplicatesRouter from "./duplicates";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(duplicatesRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
});

function row(over: Record<string, unknown> = {}) {
  return {
    group_key: "name|smith|1965-04-12",
    match_reason: "dob_lastname",
    patient_id: "p1",
    legal_first_name: "JANE",
    legal_last_name: "SMITH",
    date_of_birth: "1965-04-12",
    pacware_id: "PAC-1",
    status: "active",
    has_phone: true,
    has_email: false,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("GET /patients/duplicates", () => {
  it("folds flat RPC rows into groups with member counts", async () => {
    stageSupabaseRpcResponse("patient_duplicate_groups", {
      data: [
        row({ patient_id: "p1", pacware_id: "PAC-1" }),
        row({
          patient_id: "p2",
          pacware_id: "PAC-2",
          legal_first_name: "JAYNE",
          created_at: "2026-02-01T00:00:00Z",
        }),
        row({
          group_key: "phone|+14155551212",
          match_reason: "phone",
          patient_id: "p3",
          legal_last_name: "DOE",
        }),
        row({
          group_key: "phone|+14155551212",
          match_reason: "phone",
          patient_id: "p4",
          legal_last_name: "DOH",
        }),
      ],
    });

    const res = await request(makeApp()).get("/patients/duplicates");

    expect(res.status).toBe(200);
    expect(res.body.groupCount).toBe(2);
    const nameGroup = res.body.groups.find(
      (g: { matchReason: string }) => g.matchReason === "dob_lastname",
    );
    expect(nameGroup).not.toHaveProperty("groupKey");
    expect(nameGroup.memberCount).toBe(2);
    expect(nameGroup.members.map((m: { patientId: string }) => m.patientId)).toEqual([
      "p1",
      "p2",
    ]);
    // PHI posture: markers only, no phone/email values on the wire.
    expect(nameGroup.members[0]).toHaveProperty("hasPhone", true);
    expect(nameGroup.members[0]).not.toHaveProperty("phone");
    expect(nameGroup.members[0]).not.toHaveProperty("email");
  });

  it("passes the limit through to the RPC and defaults to 100", async () => {
    stageSupabaseRpcResponse("patient_duplicate_groups", { data: [] });
    await request(makeApp()).get("/patients/duplicates");
    expect(getSupabaseRpcCallCount("patient_duplicate_groups")).toBe(1);
    expect(getSupabaseRpcArgs("patient_duplicate_groups")[0]).toEqual({
      p_max_groups: 100,
    });

    supabaseMock.reset();
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("patient_duplicate_groups", { data: [] });
    await request(makeApp()).get("/patients/duplicates?limit=25");
    expect(getSupabaseRpcArgs("patient_duplicate_groups")[0]).toEqual({
      p_max_groups: 25,
    });
  });

  it("returns an empty list when there are no collisions", async () => {
    stageSupabaseRpcResponse("patient_duplicate_groups", { data: [] });
    const res = await request(makeApp()).get("/patients/duplicates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [], groupCount: 0 });
  });

  it("rejects an out-of-range limit", async () => {
    const res = await request(makeApp()).get("/patients/duplicates?limit=9999");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("500s with a tagged error when the RPC fails", async () => {
    stageSupabaseRpcResponse("patient_duplicate_groups", {
      error: { message: "boom" },
    });
    const res = await request(makeApp()).get("/patients/duplicates");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("duplicate_scan_failed");
  });
});
