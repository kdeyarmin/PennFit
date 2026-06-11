// Route tests for POST /patients — admin-initiated patient creation.
//
// Coverage focuses on the optional-Pacware-id contract (migration
// 0303): the id may be omitted, null, or blank, all of which insert
// NULL; a provided id still round-trips and still 409s on duplicate.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Bypass idempotency middleware — these tests aren't about
// idempotency semantics.
vi.mock("../../middlewares/idempotency", () => ({
  withIdempotency: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import createRouter from "./create";

const NEW_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", createRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: "ops@penn.example.com",
    role: "admin",
  };
}

const BASE_BODY = {
  legalFirstName: "Alice",
  legalLastName: "Smith",
  dateOfBirth: "1960-04-12",
};

describe("POST /patients", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 with no session", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/patients")
      .send({ ...BASE_BODY, pacwareId: "PAC-001" });
    expect(res.status).toBe(401);
  });

  it("creates a patient with NO pacwareId (omitted → NULL column)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "insert", { data: { id: NEW_ID } });

    const res = await request(makeApp())
      .post("/resupply-api/patients")
      .send(BASE_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: NEW_ID });

    const [payload] = getSupabaseWritePayloads("patients", "insert") as Array<
      Record<string, unknown>
    >;
    expect(payload.pacware_id).toBeNull();

    // Audit lists only populated fields — pacwareId must be absent.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0] as {
      metadata: { fields: string[] };
    };
    expect(audit.metadata.fields).not.toContain("pacwareId");
  });

  it("treats a blank pacwareId ('' / null) as NULL", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "insert", { data: { id: NEW_ID } });
    stageSupabaseResponse("patients", "insert", { data: { id: NEW_ID } });

    const resBlank = await request(makeApp())
      .post("/resupply-api/patients")
      .send({ ...BASE_BODY, pacwareId: "" });
    expect(resBlank.status).toBe(201);

    const resNull = await request(makeApp())
      .post("/resupply-api/patients")
      .send({ ...BASE_BODY, pacwareId: null });
    expect(resNull.status).toBe(201);

    const payloads = getSupabaseWritePayloads("patients", "insert") as Array<
      Record<string, unknown>
    >;
    expect(payloads[0].pacware_id).toBeNull();
    expect(payloads[1].pacware_id).toBeNull();
  });

  it("round-trips a provided pacwareId and audits the field", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "insert", { data: { id: NEW_ID } });

    const res = await request(makeApp())
      .post("/resupply-api/patients")
      .send({ ...BASE_BODY, pacwareId: "PAC-001" });

    expect(res.status).toBe(201);
    const [payload] = getSupabaseWritePayloads("patients", "insert") as Array<
      Record<string, unknown>
    >;
    expect(payload.pacware_id).toBe("PAC-001");

    const audit = logAuditMock.mock.calls[0][0] as {
      metadata: { fields: string[] };
    };
    expect(audit.metadata.fields).toContain("pacwareId");
  });

  it("still 409s on a duplicate pacware_id", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "insert", {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "patients_pacware_id_unique"',
        details: "Key (pacware_id)=(PAC-001) already exists.",
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/patients")
      .send({ ...BASE_BODY, pacwareId: "PAC-001" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate_pacware_id");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("rejects a missing name with 400 (other required fields unchanged)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/patients")
      .send({ dateOfBirth: "1960-04-12" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});
