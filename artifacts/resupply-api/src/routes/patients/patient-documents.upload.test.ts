// Route tests for the admin "scan & upload to chart" endpoints added to
// patient-documents.ts: the presigned-URL step, the finalize step
// (tag + retention + reviewed stamp), and the optional
// "this scan is the signed return" → mark-signature-returned cascade.

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

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

const {
  getObjectEntityUploadURLMock,
  normalizeObjectEntityPathMock,
  trySetAclMock,
  getObjectEntityFileMock,
} = vi.hoisted(() => ({
  getObjectEntityUploadURLMock: vi.fn(async () => "https://up.example/url"),
  normalizeObjectEntityPathMock: vi.fn(() => "private/uploads/abc"),
  trySetAclMock: vi.fn(async () => "private/uploads/abc"),
  getObjectEntityFileMock: vi.fn(async () => ({
    getMetadata: async () => [{ size: 2048, contentType: "application/pdf" }],
    delete: async () => undefined,
  })),
}));
vi.mock("../../lib/object-storage/objectStorage", () => {
  class ObjectNotFoundError extends Error {}
  class ObjectStorageService {
    getObjectEntityUploadURL = getObjectEntityUploadURLMock;
    normalizeObjectEntityPath = normalizeObjectEntityPathMock;
    trySetObjectEntityAclPolicy = trySetAclMock;
    getObjectEntityFile = getObjectEntityFileMock;
  }
  return { ObjectNotFoundError, ObjectStorageService };
});
vi.mock("../../lib/object-storage/objectAcl", () => ({
  ObjectAlreadyOwnedError: class extends Error {},
}));

import documentsRouter from "./patient-documents";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "csr@penn.example.com",
  role: "admin",
};
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(documentsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
  logAuditMock.mockClear();
});

describe("POST /patients/:id/documents/upload-url", () => {
  it("issues a presigned URL for a valid tag + content type", async () => {
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/documents/upload-url`)
      .send({
        documentType: "signed_delivery_ticket",
        filename: "scan.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
      });
    expect(res.status).toBe(200);
    expect(res.body.uploadURL).toBe("https://up.example/url");
    expect(res.body.objectPath).toBe("private/uploads/abc");
  });

  it("400s on an unknown document type", async () => {
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/documents/upload-url`)
      .send({
        documentType: "not_a_real_type",
        filename: "scan.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
      });
    expect(res.status).toBe(400);
  });

  it("400s on a disallowed content type", async () => {
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/documents/upload-url`)
      .send({
        documentType: "referral",
        filename: "scan.exe",
        contentType: "application/x-msdownload",
        sizeBytes: 2048,
      });
    expect(res.status).toBe(400);
  });
});

describe("POST /patients/:id/documents (finalize)", () => {
  it("files the document tagged + reviewed and returns the id", async () => {
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: "doc-1" },
    });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/documents`)
      .send({
        documentType: "sleep_study",
        objectPath: "private/uploads/abc",
        filename: "psg.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "doc-1",
      signatureMarkedReturned: false,
    });
    const inserts = supabaseMock.writePayloads("patient_documents", "insert");
    expect(inserts[0]).toMatchObject({
      document_type: "sleep_study",
      reviewed_by_admin_id: "u_admin",
    });
    // reviewed_at stamped so staff uploads stay out of the unreviewed queue.
    expect((inserts[0] as { reviewed_at?: string }).reviewed_at).toBeTruthy();
  });

  it("marks an outstanding signature returned when a tracking code is supplied", async () => {
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: "doc-2" },
    });
    // lookupTrackingByCode → an awaiting prescription-request tracking row.
    stageSupabaseResponse("signature_tracking", "select", {
      data: {
        id: "trk-1",
        tracking_code: "PFS-ABCD2345",
        document_kind: "prescription_request",
        document_id: "pp-1",
        patient_id: PATIENT_ID,
        provider_id: "p1",
        patient_label: "Doe, Jane",
        provider_label: "Dr. A",
        practice_name: null,
        title: "Prescription request",
        status: "awaiting_signature",
        delivery_channel: "fax",
        return_fax_e164: null,
        sent_count: 1,
        last_sent_at: null,
        returned_at: null,
        canceled_at: null,
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
      },
    });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/documents`)
      .send({
        documentType: "prescription",
        objectPath: "private/uploads/abc",
        filename: "signed-rx.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        signatureTrackingCode: "pfs-abcd2345",
      });
    expect(res.status).toBe(201);
    expect(res.body.signatureMarkedReturned).toBe(true);
    // Tracking marked returned + the source packet stamped signed.
    expect(supabaseMock.callCount("signature_tracking", "update")).toBe(1);
    const packetUpdates = supabaseMock.writePayloads(
      "prescription_request_packets",
      "update",
    );
    expect(packetUpdates[0]).toMatchObject({ status: "signed" });
  });
});
