// Route tests for /admin/billing/notes (migration 0467 — the billing
// team's free-form notes log).
//
// Mirrors order-notes.test.ts. Coverage:
//   * 401 paths for GET + POST (no admin)
//   * GET returns the notes array
//   * POST validates body length (empty + over-limit) and category
//   * POST inserts + audits with non-PHI metadata; the envelope never
//     contains the body content

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
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import billingNotesRouter from "./billing-notes";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingNotesRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/billing/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/billing/notes");
    expect(res.status).toBe(401);
  });

  it("400s with an unknown category filter", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/billing/notes?category=bogus",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns the notes list", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("billing_notes", "select", {
      data: [
        {
          id: "note_1",
          category: "payer",
          patient_id: null,
          body: "Aetna sitting on the August batch — escalated to rep.",
          author_email: "biller@penn.example.com",
          author_user_id: "u_admin",
          created_at: new Date("2026-06-03T15:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/billing/notes");
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]).toMatchObject({
      id: "note_1",
      category: "payer",
      patientId: null,
      body: "Aetna sitting on the August batch — escalated to rep.",
      authorEmail: "biller@penn.example.com",
    });
  });
});

describe("POST /admin/billing/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post("/admin/billing/notes")
      .send({ body: "test" });
    expect(res.status).toBe(401);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/billing/notes")
      .send({ body: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("billing_notes", "insert")).toBe(0);
  });

  it("400s with over-limit body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/billing/notes")
      .send({ body: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("400s with an unknown category", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/billing/notes")
      .send({ body: "ok", category: "bogus" });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("billing_notes", "insert")).toBe(0);
  });

  it("404s when a linked patient doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post("/admin/billing/notes")
      .send({ body: "About a patient account", patientId: PATIENT_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
    expect(getSupabaseCallCount("billing_notes", "insert")).toBe(0);
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("billing_notes", "insert", {
      data: {
        id: "note_new",
        created_at: new Date("2026-06-04T12:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp()).post("/admin/billing/notes").send({
      category: "collections",
      body: "Agency wants the next overdue export by Friday; balance climbing.",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: "note_new",
      createdAt: "2026-06-04T12:00:00.000Z",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("billing.note.create");
    expect(audit.targetTable).toBe("billing_notes");
    expect(audit.targetId).toBe("note_new");
    expect(audit.metadata).toEqual({
      category: "collections",
      patient_id: null,
      body_length:
        "Agency wants the next overdue export by Friday; balance climbing."
          .length,
    });
    // Critical: no body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("Agency");
    expect(JSON.stringify(audit.metadata)).not.toContain("Friday");
  });
});
