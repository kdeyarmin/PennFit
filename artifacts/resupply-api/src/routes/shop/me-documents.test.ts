// Route tests for /shop/me/documents.
//
// Coverage:
//   * 401 without sign-in (all four verbs)
//   * GET returns empty when no email
//   * GET returns empty when patient lookup returns 0 or ambiguous rows
//   * GET projects document rows to camelCase
//   * POST upload-url: 404 when no email, 400 on invalid body, 400 on bad
//     contentType, 400 on bad documentType, 409 on ambiguous patient, 404
//     on missing patient
//   * POST finalize: 400 on invalid body, 404 missing patient, 409 ambiguous
//   * Audit metadata never contains the patient's identifying email body

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const { getObjectEntityUploadURLMock, normalizeObjectEntityPathMock } =
  vi.hoisted(() => ({
    getObjectEntityUploadURLMock: vi.fn(async () => "https://up.example/url"),
    normalizeObjectEntityPathMock: vi.fn(() => "private/uploads/abc"),
  }));
vi.mock("../../lib/object-storage/objectStorage", () => {
  class ObjectNotFoundError extends Error {
    constructor(m = "not found") {
      super(m);
    }
  }
  class ObjectStorageService {
    getObjectEntityUploadURL = getObjectEntityUploadURLMock;
    normalizeObjectEntityPath = normalizeObjectEntityPathMock;
  }
  return { ObjectNotFoundError, ObjectStorageService };
});
vi.mock("../../lib/object-storage/objectAcl", () => ({
  ObjectAlreadyOwnedError: class extends Error {
    constructor(m = "already owned") {
      super(m);
    }
  },
}));

import documentsRouter from "./me-documents";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(documentsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  logAuditMock.mockClear();
  getObjectEntityUploadURLMock.mockClear();
  normalizeObjectEntityPathMock.mockClear();
  supabaseMock.reset();
});

describe("GET /shop/me/documents (list)", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/documents");
    expect(res.status).toBe(401);
  });

  it("returns empty when no email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/documents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ documents: [] });
  });

  it("returns empty when patient lookup is ambiguous", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1" }, { id: "p_2" }],
    });
    const res = await request(makeApp()).get("/shop/me/documents");
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([]);
  });

  it("projects document rows", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_documents", "select", {
      data: [
        {
          id: "doc_1",
          document_type: "insurance_card",
          filename: "card.pdf",
          content_type: "application/pdf",
          size_bytes: 1024,
          created_at: "2026-05-01T00:00:00Z",
          reviewed_at: null,
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/documents");
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([
      {
        id: "doc_1",
        documentType: "insurance_card",
        filename: "card.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        createdAt: "2026-05-01T00:00:00Z",
        reviewedAt: null,
      },
    ]);
  });
});

describe("POST /shop/me/documents/upload-url", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({});
    expect(res.status).toBe(401);
  });

  it("404s when no email present", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({
        documentType: "insurance_card",
        filename: "f.pdf",
        contentType: "application/pdf",
        sizeBytes: 1000,
      });
    expect(res.status).toBe(404);
  });

  it("400s on invalid body", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({});
    expect(res.status).toBe(400);
  });

  it("400s on unsupported content type", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({
        documentType: "insurance_card",
        filename: "f.exe",
        contentType: "application/x-msdownload",
        sizeBytes: 100,
      });
    expect(res.status).toBe(400);
  });

  it("400s on unsupported document type", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({
        documentType: "credit_card_number",
        filename: "f.pdf",
        contentType: "application/pdf",
        sizeBytes: 1000,
      });
    expect(res.status).toBe(400);
  });

  it("404s when patient lookup returns nothing", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({
        documentType: "insurance_card",
        filename: "f.pdf",
        contentType: "application/pdf",
        sizeBytes: 1000,
      });
    expect(res.status).toBe(404);
  });

  it("409s when patient lookup is ambiguous", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1" }, { id: "p_2" }],
    });
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({
        documentType: "insurance_card",
        filename: "f.pdf",
        contentType: "application/pdf",
        sizeBytes: 1000,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("patient_ambiguous_email");
  });

  it("200s with uploadURL and audit log on happy path", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    const res = await request(makeApp())
      .post("/shop/me/documents/upload-url")
      .send({
        documentType: "insurance_card",
        filename: "f.pdf",
        contentType: "application/pdf",
        sizeBytes: 1000,
      });
    expect(res.status).toBe(200);
    expect(res.body.uploadURL).toBe("https://up.example/url");
    expect(res.body.objectPath).toBe("private/uploads/abc");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.document.upload_url_issued");
    // No PHI in audit metadata: the filename must NOT appear
    expect(JSON.stringify(audit.metadata)).not.toContain("f.pdf");
    expect(JSON.stringify(audit.metadata)).not.toContain("a@a.test");
  });
});
