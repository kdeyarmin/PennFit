// Route tests for clinical encounter admin routes (F3).

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
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

import clinicalEncountersRouter from "./clinical-encounters";

// A respiratory therapist: coarse "agent" with the granular rt role,
// which holds clinical.read + clinical.note.write.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const PATIENT_ID = "pat_1";
const QUERY_BASE = "/admin/patients/clinical-encounters/query";
const MUTATION_BASE = `/admin/patients/${PATIENT_ID}/clinical-encounters`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(clinicalEncountersRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("POST clinical-encounters/query", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(QUERY_BASE)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(401);
  });

  it("403s for the CSR tier (lacks clinical.read)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post(QUERY_BASE)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("clinical.read");
  });

  it("400s on an invalid query body", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).post(QUERY_BASE).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("clinical_encounters", "select")).toBe(0);
  });

  it("returns the mapped encounter list for an RT", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "select", {
      data: [
        {
          id: "enc_1",
          encounter_type: "mask_fit",
          reason: "leak complaint",
          assessment: null,
          intervention: "refit P10 medium",
          plan: null,
          follow_up_at: null,
          note: "Seal good after refit.",
          linked_alert_id: null,
          linked_episode_id: null,
          author_email: "rt@penn.example.com",
          created_at: "2026-05-31T10:00:00Z",
        },
      ],
    });
    const res = await request(makeApp())
      .post(QUERY_BASE)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(200);
    expect(res.body.encounters).toHaveLength(1);
    expect(res.body.encounters[0]).toMatchObject({
      id: "enc_1",
      encounterType: "mask_fit",
      intervention: "refit P10 medium",
    });
  });
});

describe("POST clinical-encounters", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(MUTATION_BASE)
      .send({ encounterType: "phone", note: "called patient" });
    expect(res.status).toBe(401);
  });

  it("403s for the CSR tier (lacks clinical.note.write)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post(MUTATION_BASE)
      .send({ encounterType: "phone", note: "called patient" });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("clinical_encounters", "insert")).toBe(0);
  });

  it("400s on an empty encounter (no note or structured field)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post(MUTATION_BASE)
      .send({ encounterType: "phone" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("clinical_encounters", "insert")).toBe(0);
  });

  it("400s on an invalid encounter type", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post(MUTATION_BASE)
      .send({ encounterType: "bogus", note: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("inserts + audits WITHOUT the clinical content (PHI)", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "insert", {
      data: { id: "enc_new", created_at: "2026-05-31T12:00:00Z" },
    });
    const res = await request(makeApp()).post(MUTATION_BASE).send({
      encounterType: "adherence_intervention",
      assessment: "Usage dropped to 2.1h; suspects mask discomfort.",
      plan: "Trial nasal pillow, follow up in 1 week.",
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("enc_new");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("clinical_encounter.create");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      encounter_type: "adherence_intervention",
    });
    // Critical: no clinical content in the audit envelope.
    const envelope = JSON.stringify(audit.metadata);
    expect(envelope).not.toContain("discomfort");
    expect(envelope).not.toContain("nasal pillow");
  });
});
