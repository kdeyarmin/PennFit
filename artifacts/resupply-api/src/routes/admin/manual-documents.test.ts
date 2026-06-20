// Tests for the manual-documents routes — the catalog contract the
// /admin/documents "New document" type dropdown depends on. Added while
// investigating an "empty type dropdown" report: the catalog is a pure
// in-code constant, so this endpoint must always return all six types
// for any staff role with patients.read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import manualDocumentsRouter from "./manual-documents";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(manualDocumentsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/manual-documents/catalog", () => {
  it("401s without admin; returns all six types with admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/manual-documents/catalog")).status,
    ).toBe(401);
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get("/admin/manual-documents/catalog");
    expect(res.status).toBe(200);
    expect(res.body.types.map((t: { type: string }) => t.type)).toEqual([
      "cmn",
      "prescription",
      "agreement",
      "delivery_ticket",
      "cover_letter",
      "other",
    ]);
  });

  it("returns the catalog for an agent (patients.read)", async () => {
    mockAdmin.current = { ...ADMIN, role: "agent" };
    const res = await request(makeApp()).get("/admin/manual-documents/catalog");
    expect(res.status).toBe(200);
    expect(res.body.types.length).toBe(6);
  });
});

describe("GET /admin/manual-documents/prefill", () => {
  it("prefills CMN sleep-study coverage details from the patient chart", async () => {
    mockAdmin.current = ADMIN;
    supabaseMock.stage("patients", "select", {
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        legal_first_name: "Pat",
        legal_last_name: "Patient",
        date_of_birth: "1970-01-02",
        phone_e164: "+12155550123",
        email: "pat@example.com",
        address: null,
      },
    });
    supabaseMock.stage("prescriptions", "select", { data: [] });
    supabaseMock.stage("sleep_studies", "select", {
      data: {
        diagnosis_icd10: "G47.33",
        study_date: "2026-05-20",
        ahi: "18.4",
        rdi: null,
        interpreting_provider_id: null,
      },
    });

    const res = await request(makeApp()).get(
      "/admin/manual-documents/prefill?patientId=11111111-1111-4111-8111-111111111111&documentType=cmn",
    );

    expect(res.status).toBe(200);
    expect(res.body.fields.clinical_justification).toContain(
      "[x] AHI or RDI ≥ 15 events per hour",
    );
    expect(res.body.fields.clinical_justification).toContain(
      "Sleep study date: 2026-05-20   AHI/RDI: 18.4",
    );
    expect(res.body.fields.diagnosis).toBe("G47.33");
  });

  it("prefills the ≥15 CMN checkbox when RDI qualifies even if AHI does not", async () => {
    mockAdmin.current = ADMIN;
    supabaseMock.stage("patients", "select", {
      data: {
        id: "33333333-3333-4333-8333-333333333333",
        legal_first_name: "Rdi",
        legal_last_name: "Qualifies",
        date_of_birth: "1975-06-07",
        phone_e164: "+12155550124",
        email: "rdi@example.com",
        address: null,
      },
    });
    supabaseMock.stage("prescriptions", "select", { data: [] });
    supabaseMock.stage("sleep_studies", "select", {
      data: {
        diagnosis_icd10: "G47.33",
        study_date: "2026-05-21",
        ahi: "4",
        rdi: "16",
        interpreting_provider_id: null,
      },
    });

    const res = await request(makeApp()).get(
      "/admin/manual-documents/prefill?patientId=33333333-3333-4333-8333-333333333333&documentType=cmn",
    );

    expect(res.status).toBe(200);
    expect(res.body.fields.clinical_justification).toContain(
      "[x] AHI or RDI ≥ 15 events per hour",
    );
    expect(res.body.fields.clinical_justification).toContain(
      "[ ] AHI or RDI ≥ 5 and ≤ 14 events per hour",
    );
    expect(res.body.fields.clinical_justification).toContain(
      "Sleep study date: 2026-05-21   AHI/RDI: 4 / 16",
    );
  });

  it("prefills the 5-14 CMN checkbox when the qualifying sleep-study value is in range", async () => {
    mockAdmin.current = ADMIN;
    supabaseMock.stage("patients", "select", {
      data: {
        id: "44444444-4444-4444-8444-444444444444",
        legal_first_name: "Mid",
        legal_last_name: "Range",
        date_of_birth: "1985-08-09",
        phone_e164: "+12155550125",
        email: "midrange@example.com",
        address: null,
      },
    });
    supabaseMock.stage("prescriptions", "select", { data: [] });
    supabaseMock.stage("sleep_studies", "select", {
      data: {
        diagnosis_icd10: "G47.33",
        study_date: "2026-05-22",
        ahi: null,
        rdi: "9.8",
        interpreting_provider_id: null,
      },
    });

    const res = await request(makeApp()).get(
      "/admin/manual-documents/prefill?patientId=44444444-4444-4444-8444-444444444444&documentType=cmn",
    );

    expect(res.status).toBe(200);
    expect(res.body.fields.clinical_justification).toContain(
      "[ ] AHI or RDI ≥ 15 events per hour",
    );
    expect(res.body.fields.clinical_justification).toContain(
      "[x] AHI or RDI ≥ 5 and ≤ 14 events per hour",
    );
    expect(res.body.fields.clinical_justification).toContain(
      "Sleep study date: 2026-05-22   AHI/RDI: 9.8",
    );
  });

  it("leaves CMN sleep-study coverage blanks when the chart has no study", async () => {
    mockAdmin.current = ADMIN;
    supabaseMock.stage("patients", "select", {
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        legal_first_name: "No",
        legal_last_name: "Study",
        date_of_birth: "1980-03-04",
        phone_e164: null,
        email: null,
        address: null,
      },
    });
    supabaseMock.stage("prescriptions", "select", { data: [] });
    supabaseMock.stage("sleep_studies", "select", { data: null });

    const res = await request(makeApp()).get(
      "/admin/manual-documents/prefill?patientId=22222222-2222-4222-8222-222222222222&documentType=cmn",
    );

    expect(res.status).toBe(200);
    expect(res.body.fields.clinical_justification).toContain(
      "[ ] AHI or RDI ≥ 15 events per hour",
    );
    expect(res.body.fields.clinical_justification).toContain(
      "Sleep study date: ______________   AHI/RDI: ______________",
    );
  });

  it("prefills the prescription ICD-10 from the sleep-study diagnosis", async () => {
    mockAdmin.current = ADMIN;
    supabaseMock.stage("patients", "select", {
      data: {
        id: "55555555-5555-4555-8555-555555555555",
        legal_first_name: "Dx",
        legal_last_name: "Patient",
        date_of_birth: "1975-06-07",
        phone_e164: null,
        email: null,
        address: null,
      },
    });
    supabaseMock.stage("prescriptions", "select", { data: [] });
    supabaseMock.stage("sleep_studies", "select", {
      data: {
        diagnosis_icd10: "G47.33",
        study_date: "2026-05-01",
        ahi: "20",
        rdi: null,
        interpreting_provider_id: null,
      },
    });

    const res = await request(makeApp()).get(
      "/admin/manual-documents/prefill?patientId=55555555-5555-4555-8555-555555555555&documentType=prescription",
    );

    expect(res.status).toBe(200);
    expect(res.body.fields.icd10_codes).toBe("G47.33");
  });
});

describe("GET /admin/manual-documents/catalog — required flags", () => {
  it("stamps `required` on the fields a document is invalid without", () => {
    mockAdmin.current = ADMIN;
    return request(makeApp())
      .get("/admin/manual-documents/catalog")
      .then((res) => {
        expect(res.status).toBe(200);
        const rx = res.body.types.find(
          (t: { type: string }) => t.type === "prescription",
        );
        const required = new Set(
          rx.fields
            .filter((f: { required?: boolean }) => f.required)
            .map((f: { key: string }) => f.key),
        );
        expect(required.has("prescriber_npi")).toBe(true);
        expect(required.has("items_ordered")).toBe(true);
        // A field the prescriber completes is NOT required to send.
        expect(required.has("directions")).toBe(false);
      });
  });
});

describe("send gate — incomplete documents are blocked before dispatch", () => {
  const DOC_ID = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => {
    vi.stubEnv("SENDGRID_API_KEY", "SG.test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("422s an incomplete prescription on send-email, listing what's missing", async () => {
    mockAdmin.current = ADMIN;
    // loadManualDocumentRow → a prescription with the identity filled but
    // the prescriber NPI + items still blank.
    stageSupabaseResponse("manual_documents", "select", {
      data: {
        id: DOC_ID,
        document_type: "prescription",
        title: "PAP order",
        fields: {
          patient_name: "Jordan Rivera",
          date_of_birth: "1980-02-02",
          prescriber_name: "Dr. Ada Lin",
        },
        body: null,
        recipient_name: "Dr. Ada Lin",
        recipient_address: null,
        recipient_email: "dr@example.test",
        recipient_fax_e164: null,
        status: "draft",
      },
    });

    const res = await request(makeApp())
      .post(`/admin/manual-documents/${DOC_ID}/send-email`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("document_incomplete");
    expect(
      res.body.missingFields.map((m: { key: string }) => m.key).sort(),
    ).toEqual([
      "icd10_codes",
      "items_ordered",
      "length_of_need",
      "prescriber_npi",
    ]);
  });
});
