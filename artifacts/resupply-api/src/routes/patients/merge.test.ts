// Route test for POST /patients/merge (CSR #C1, merge half). The atomic
// cross-table repoint lives in the resupply.merge_patient_records RPC
// (migration 0225); this pins the route's validation + its mapping of the
// RPC's RAISEd SQLSTATEs to HTTP statuses.

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
  getSupabaseRpcArgs,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import mergeRouter from "./merge";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

const PRIMARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DUPLICATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(mergeRouter);
  return app;
}

function post(body: Record<string, unknown>) {
  return request(makeApp()).post("/patients/merge").send(body);
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
});

describe("POST /patients/merge", () => {
  it("merges and returns the RPC summary", async () => {
    stageSupabaseRpcResponse("merge_patient_records", {
      data: { tablesRepointed: 3, rowsRepointed: 12 },
    });
    const res = await post({
      primaryPatientId: PRIMARY,
      duplicatePatientId: DUPLICATE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      tablesRepointed: 3,
      rowsRepointed: 12,
    });
    expect(getSupabaseRpcArgs("merge_patient_records")[0]).toEqual({
      p_primary: PRIMARY,
      p_duplicate: DUPLICATE,
    });
  });

  it("400s on identical ids before hitting the RPC", async () => {
    const res = await post({
      primaryPatientId: PRIMARY,
      duplicatePatientId: PRIMARY,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("same_patient");
  });

  it("400s on a non-uuid id", async () => {
    const res = await post({
      primaryPatientId: "not-a-uuid",
      duplicatePatientId: DUPLICATE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("maps a unique-violation to 409 merge_conflict", async () => {
    stageSupabaseRpcResponse("merge_patient_records", {
      error: { code: "23505", message: "duplicate key" },
    });
    const res = await post({
      primaryPatientId: PRIMARY,
      duplicatePatientId: DUPLICATE,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("merge_conflict");
  });

  it("maps a missing patient to 404", async () => {
    stageSupabaseRpcResponse("merge_patient_records", {
      error: { code: "P0002", message: "primary patient not found" },
    });
    const res = await post({
      primaryPatientId: PRIMARY,
      duplicatePatientId: DUPLICATE,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("maps an already-merged duplicate to 409", async () => {
    stageSupabaseRpcResponse("merge_patient_records", {
      error: { code: "P0003", message: "duplicate is already merged" },
    });
    const res = await post({
      primaryPatientId: PRIMARY,
      duplicatePatientId: DUPLICATE,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_merged");
  });
});
