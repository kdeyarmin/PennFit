// Tests for the clinical-outreach routes (RT #23) — gates + wiring.

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

import clinicalOutreachRouter from "./clinical-outreach";

const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
// csr lacks clinical.intervention.write.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(clinicalOutreachRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/clinical/outreach/eligible", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/clinical/outreach/eligible"))
        .status,
    ).toBe(401);
  });

  it("returns due patients (open interventions, not recently contacted)", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "select", {
      data: [
        {
          id: "e1",
          patient_id: "p1",
          assessment_category: "motivation",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    });
    stageSupabaseResponse("clinical_outreach_log", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/clinical/outreach/eligible",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.eligible[0].patientId).toBe("p1");
    expect(res.body.eligible[0].category).toBe("motivation");
  });
});

describe("POST /admin/clinical/outreach/run", () => {
  it("403s a role without clinical.intervention.write (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post("/admin/clinical/outreach/run")
      .send({});
    expect(res.status).toBe(403);
  });

  it("400s an out-of-range cap", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post("/admin/clinical/outreach/run")
      .send({ cap: 9999 });
    expect(res.status).toBe(400);
  });
});
