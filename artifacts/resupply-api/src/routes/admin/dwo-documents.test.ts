// Tests for the DWO/CMN PDF generate route added in this PR:
//   GET /admin/dwo-documents/:id/pdf  (patients.read)

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
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import dwoDocumentsRouter from "./dwo-documents";

const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const DWO_ID = "11111111-2222-4333-8444-555555555555";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(dwoDocumentsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/dwo-documents/:id/pdf", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(makeApp()).get(
      `/admin/dwo-documents/${DWO_ID}/pdf`,
    );
    expect(res.status).toBe(401);
  });

  it("404s when the document doesn't exist", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("dwo_documents", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/dwo-documents/${DWO_ID}/pdf`,
    );
    expect(res.status).toBe(404);
  });

  it("streams a PDF for a complete DWO row", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("dwo_documents", "select", {
      data: {
        id: DWO_ID,
        patient_id: "p1",
        hcpcs_family: "oxygen",
        form_type: "cmn_484",
        signing_provider_id: "prov1",
        signed_on: "2026-01-10",
        expires_on: "2027-01-10",
        notes: "Home O2 2 LPM",
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "Jordan",
        legal_last_name: "Rivera",
        date_of_birth: "1971-04-02",
        address: {
          line1: "1 Main St",
          city: "Phila",
          state: "PA",
          postalCode: "19103",
        },
      },
    });
    stageSupabaseResponse("providers", "select", {
      data: {
        legal_name: "Dr. Pat Lee",
        npi: "1234567890",
        practice_name: "Sleep Health",
        phone_e164: "+12155551212",
        fax_e164: null,
      },
    });

    const res = await request(makeApp()).get(
      `/admin/dwo-documents/${DWO_ID}/pdf`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("422s when the patient is missing required fields", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("dwo_documents", "select", {
      data: {
        id: DWO_ID,
        patient_id: "p1",
        hcpcs_family: "pap",
        form_type: "dwo",
        signing_provider_id: null,
        signed_on: "2026-01-10",
        expires_on: "2027-01-10",
        notes: null,
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "",
        legal_last_name: "",
        date_of_birth: "",
        address: null,
      },
    });
    const res = await request(makeApp()).get(
      `/admin/dwo-documents/${DWO_ID}/pdf`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("incomplete_inputs");
  });
});
