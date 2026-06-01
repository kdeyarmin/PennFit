// Tests for the CMN/DIF document routes (Biller #29) — gates + the
// complete-requires-valid-answers guard + worklist wiring.

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

import cmnDocumentsRouter from "./cmn-documents";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
const PATIENT = "11111111-1111-4111-8111-111111111111";
const CMN = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cmnDocumentsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/billing/cmn-catalog", () => {
  it("401s without admin; returns the catalog with admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/billing/cmn-catalog")).status,
    ).toBe(401);
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get("/admin/billing/cmn-catalog");
    expect(res.status).toBe(200);
    expect(res.body.forms.length).toBeGreaterThan(0);
    expect(res.body.forms[0]).toHaveProperty("requiredKeys");
  });
});

describe("POST /admin/patients/:id/cmn-documents", () => {
  it("400s an unknown form type", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT}/cmn-documents`)
      .send({ formType: "bogus", hcpcsCode: "E1390" });
    expect(res.status).toBe(400);
  });

  it("creates a draft for a valid form", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("cmn_documents", "insert", {
      data: { id: CMN },
      error: null,
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT}/cmn-documents`)
      .send({ formType: "cms_484", hcpcsCode: "E1390" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CMN);
  });
});

describe("PATCH /admin/cmn-documents/:cmnId", () => {
  it("409s when completing an incomplete form, listing the gaps", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("cmn_documents", "select", {
      data: { id: CMN, form_type: "cms_484", answers: {} },
      error: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/cmn-documents/${CMN}`)
      .send({ status: "completed" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("incomplete");
    expect(res.body.missing.length).toBeGreaterThan(0);
  });

  it("completes when answers satisfy the form", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("cmn_documents", "select", {
      data: {
        id: CMN,
        form_type: "cms_484",
        answers: {
          arterial_po2_or_sat: "55",
          test_date: "2026-05-01",
          test_condition: "rest",
          oxygen_flow_rate_lpm: 2,
        },
      },
      error: null,
    });
    stageSupabaseResponse("cmn_documents", "update", { data: {}, error: null });
    const res = await request(makeApp())
      .patch(`/admin/cmn-documents/${CMN}`)
      .send({ status: "completed" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("GET /admin/billing/cmn-worklist", () => {
  it("lists drafts with readiness", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("cmn_documents", "select", {
      data: [
        {
          id: CMN,
          patient_id: PATIENT,
          form_type: "cms_484",
          hcpcs_code: "E1390",
          status: "draft",
          answers: {
            arterial_po2_or_sat: "55",
            test_date: "2026-05-01",
            test_condition: "rest",
            oxygen_flow_rate_lpm: 2,
          },
          created_at: "2026-05-10T00:00:00Z",
        },
      ],
      error: null,
    });
    const res = await request(makeApp()).get("/admin/billing/cmn-worklist");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.readyToComplete).toBe(1);
    expect(res.body.items[0].missingCount).toBe(0);
  });
});
