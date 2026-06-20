// Route tests for /patients/:id/followups (Phase 19).
// Mirrors customer-followups.test.ts but on the patient surface.

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

import followupsRouter from "./followups";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const FOLLOWUP_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(followupsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /patients/:id/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/followups`,
    );
    expect(res.status).toBe(401);
  });

  it("404s when the patient doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/followups`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns the open queue", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_followups", "select", {
      data: [
        {
          id: FOLLOWUP_ID,
          body: "Follow up on prescription expiry",
          due_at: new Date("2026-05-12T16:00:00Z").toISOString(),
          completed_at: null,
          completed_by_email: null,
          created_by_email: "ops@penn.example.com",
          created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/followups`,
    );
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(1);
    expect(res.body.followups[0].body).toBe("Follow up on prescription expiry");
  });
});

describe("POST /patients/:id/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/followups`)
      .send({ body: "x", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(401);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/followups`)
      .send({ body: "  ", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("patient_followups", "insert")).toBe(0);
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_followups", "insert", {
      data: {
        id: FOLLOWUP_ID,
        created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
        due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
      },
    });

    const body =
      "Patient said device is leaking — verify replacement mask shipped.";
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/followups`)
      .send({ body, dueAt: "2026-05-10T16:00:00Z" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(FOLLOWUP_ID);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.followup.create");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      body_length: body.length,
      due_at: "2026-05-10T16:00:00.000Z",
    });
    // No body content in the audit envelope — patient bodies almost
    // certainly carry PHI.
    expect(JSON.stringify(audit.metadata)).not.toContain("leaking");
    expect(JSON.stringify(audit.metadata)).not.toContain("replacement");
  });
});

describe("PATCH /patients/:id/followups/:fid/complete", () => {
  it("404s when the followup belongs to a different patient", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        patient_id: "33333333-3333-4333-8333-333333333333",
        completed_at: null,
        body: "x",
      },
    });
    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(404);
  });

  it("409s when the followup is already complete", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        patient_id: PATIENT_ID,
        completed_at: new Date("2026-05-04T15:00:00Z").toISOString(),
        body: "x",
      },
    });
    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(409);
  });

  it("marks complete + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        patient_id: PATIENT_ID,
        completed_at: null,
        body: "Confirm replacement",
        due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
      },
    });
    stageSupabaseResponse("patient_followups", "update", {
      data: {
        id: FOLLOWUP_ID,
        completed_at: new Date("2026-05-05T16:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/complete`,
    );

    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBe("2026-05-05T16:00:00.000Z");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.followup.complete");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      body_length: "Confirm replacement".length,
      due_at: "2026-05-10T16:00:00.000Z",
    });
  });
});

describe("PATCH /patients/:id/followups/:fid/reopen", () => {
  it("409s when the followup is already open", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        patient_id: PATIENT_ID,
        completed_at: null,
        body: "x",
      },
    });
    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/reopen`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_open");
  });

  it("reopens a completed followup + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        patient_id: PATIENT_ID,
        completed_at: new Date("2026-05-05T16:00:00Z").toISOString(),
        body: "Confirm replacement",
        due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
      },
    });
    stageSupabaseResponse("patient_followups", "update", {
      data: {
        id: FOLLOWUP_ID,
        completed_at: null,
      },
    });

    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/reopen`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: FOLLOWUP_ID, completedAt: null });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.followup.reopen");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      body_length: "Confirm replacement".length,
      due_at: "2026-05-10T16:00:00.000Z",
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("Confirm replacement");
  });
});
