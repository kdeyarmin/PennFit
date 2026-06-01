// Tests for RT #21 interventions — the pure worklist sort + the three
// routes' gates and wiring.

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

import interventionsRouter, {
  buildInterventionWorklist,
  type InterventionRow,
} from "./interventions";

// rt (clinician) holds clinical.read + clinical.intervention.write.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
// csr lacks the clinical perms → 403.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

const PATIENT_ID = "patient_1";
const ENC_ID = "enc_1";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(interventionsRouter);
  return app;
}

function row(over: Partial<InterventionRow>): InterventionRow {
  return {
    id: "i1",
    patient_id: PATIENT_ID,
    assessment_category: "mask_leak",
    outcome_status: "pending",
    reason: null,
    plan: null,
    follow_up_at: null,
    author_email: "rt@penn.example.com",
    created_at: "2026-05-20T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildInterventionWorklist (pure)", () => {
  it("puts open (pending) items first, soonest follow-up first", () => {
    const items = buildInterventionWorklist([
      row({
        id: "resolved",
        outcome_status: "improved",
        created_at: "2026-05-25T00:00:00.000Z",
      }),
      row({
        id: "open_later",
        outcome_status: "pending",
        follow_up_at: "2026-06-10T00:00:00.000Z",
      }),
      row({
        id: "open_sooner",
        outcome_status: "pending",
        follow_up_at: "2026-06-01T00:00:00.000Z",
      }),
    ]);
    expect(items.map((i) => i.id)).toEqual([
      "open_sooner",
      "open_later",
      "resolved",
    ]);
    expect(items[0].open).toBe(true);
    expect(items[2].open).toBe(false);
  });

  it("treats a null outcome_status as pending/open", () => {
    const items = buildInterventionWorklist([
      row({ id: "x", outcome_status: null }),
    ]);
    expect(items[0].outcomeStatus).toBe("pending");
    expect(items[0].open).toBe(true);
  });
});

describe("POST /admin/patients/:id/interventions", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({ assessmentCategory: "mask_leak" });
    expect(res.status).toBe(401);
  });

  it("403s for a role without clinical.intervention.write (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({ assessmentCategory: "mask_leak" });
    expect(res.status).toBe(403);
  });

  it("400s on an invalid assessment category", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({ assessmentCategory: "bogus" });
    expect(res.status).toBe(400);
  });

  it("creates an adherence_intervention seeded to pending", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "insert", {
      data: { id: ENC_ID, created_at: "2026-05-20T00:00:00.000Z" },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({
        assessmentCategory: "claustrophobia",
        plan: "Trial a nasal pillow mask; coach on desensitization.",
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: ENC_ID, outcomeStatus: "pending" });
  });
});

describe("GET /admin/clinical/interventions", () => {
  it("403s for csr", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/clinical/interventions");
    expect(res.status).toBe(403);
  });

  it("returns the worklist with an open count", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "select", {
      data: [
        row({ id: "a", outcome_status: "pending" }),
        row({ id: "b", outcome_status: "improved" }),
      ],
    });
    const res = await request(makeApp()).get("/admin/clinical/interventions");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.openCount).toBe(1);
    expect(res.body.interventions[0].id).toBe("a"); // open first
  });
});

describe("PATCH /admin/interventions/:id/outcome", () => {
  it("403s for csr", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "improved" });
    expect(res.status).toBe(403);
  });

  it("400s on an invalid outcome", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "bogus" });
    expect(res.status).toBe(400);
  });

  it("404s when the intervention doesn't exist", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "improved" });
    expect(res.status).toBe(404);
  });

  it("records the outcome", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "update", {
      data: { id: ENC_ID, outcome_status: "improved" },
    });
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "improved" });
    expect(res.status).toBe(200);
    expect(res.body.outcomeStatus).toBe("improved");
  });
});
