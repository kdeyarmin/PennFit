// Route tests for /admin/referral-reviews — the Referral Reviewer.
//
// The extraction itself is pinned in lib/referral-review/extract.test.ts
// and the splitter in split-pdf.test.ts; these cover the route layer:
// permission gates, the upload finalize validation, the duplicate guard,
// and the accept path (patient + coverages + documents + fax attach +
// review settle).

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
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
vi.mock("../../middlewares/idempotency", () => ({
  withIdempotency: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

const {
  getObjectEntityUploadURLMock,
  normalizeObjectEntityPathMock,
  trySetAclMock,
  getFileMock,
  downloadObjectMock,
  ObjectNotFoundErrorClass,
} = vi.hoisted(() => ({
  getObjectEntityUploadURLMock: vi.fn(async () => "https://up.example/url"),
  normalizeObjectEntityPathMock: vi.fn(() => "/objects/uploads/abc"),
  trySetAclMock: vi.fn(async () => "/objects/uploads/abc"),
  getFileMock: vi.fn(async (_path?: unknown) => ({
    bucket: "b",
    path: "p",
    getMetadata: async () => [{ size: 2048, contentType: "application/pdf" }],
    delete: async () => undefined,
  })),
  downloadObjectMock: vi.fn(async (_file?: unknown) => ({
    status: 200,
    headers: new Map(),
    arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    body: null,
  })),
  ObjectNotFoundErrorClass: class ObjectNotFoundError extends Error {},
}));
vi.mock("../../lib/object-storage/objectStorage", () => ({
  ObjectNotFoundError: ObjectNotFoundErrorClass,
  ObjectStorageService: class {
    getObjectEntityUploadURL = getObjectEntityUploadURLMock;
    normalizeObjectEntityPath = normalizeObjectEntityPathMock;
    trySetObjectEntityAclPolicy = trySetAclMock;
    getObjectEntityFile = (path: string) => getFileMock(path);
    downloadObject = (file: unknown) => downloadObjectMock(file);
  },
}));
vi.mock("../../lib/object-storage/objectAcl", () => ({
  ObjectAlreadyOwnedError: class extends Error {},
}));

const { runExtractionMock } = vi.hoisted(() => ({
  runExtractionMock: vi.fn(),
}));
vi.mock("../../lib/referral-review/run", () => ({
  runReviewExtraction: runExtractionMock,
}));

const { splitMock } = vi.hoisted(() => ({
  splitMock: vi.fn(async (_bytes: Buffer, ranges: unknown[]) =>
    ranges.map(() => Buffer.from("%PDF-part")),
  ),
}));
vi.mock("../../lib/referral-review/split-pdf", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/referral-review/split-pdf")
  >("../../lib/referral-review/split-pdf");
  return { ...actual, splitPdfPages: splitMock };
});

vi.mock("../../worker/index", () => ({ getBoss: () => null }));

// uploadChartPdf PUTs the split bytes to the presigned URL.
const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
vi.stubGlobal("fetch", fetchMock);
afterAll(() => vi.unstubAllGlobals());

import referralReviewsRouter from "./referral-reviews";

const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const FAX_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";
const DOC_ID = "55555555-5555-4555-8555-555555555555";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const CLINICIAN: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt", // patients.read only — no triage, no accept
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(referralReviewsRouter);
  return app;
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    source: "fax",
    inbound_fax_id: FAX_ID,
    media_object_key: "/objects/fax-media/abc",
    media_content_type: "application/pdf",
    media_size_bytes: 4096,
    status: "extracted",
    extraction: {
      patient: {
        firstName: "Jane",
        lastName: "Doe",
        dob: "1960-02-03",
        phone: "+14155551212",
        email: null,
        address: null,
      },
    },
    extraction_model: "claude-sonnet-4-6",
    extracted_at: "2026-06-12T00:00:00.000Z",
    error_reason: null,
    created_patient_id: null,
    accepted_at: null,
    accepted_by_user_id: null,
    dismissed_at: null,
    dismissed_by_user_id: null,
    dismiss_note: null,
    created_by_user_id: null,
    created_at: "2026-06-12T00:00:00.000Z",
    updated_at: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

const ACCEPT_BODY = {
  patient: {
    legalFirstName: "Jane",
    legalLastName: "Doe",
    dateOfBirth: "1960-02-03",
    phoneE164: "+14155551212",
    email: "jane@example.com",
    address: {
      line1: "1 Main St",
      city: "Pittsburgh",
      state: "PA",
      postalCode: "15201",
      country: "US",
    },
  },
  insurance: {
    payerName: "Highmark BCBS",
    memberId: "ABC123",
    groupNumber: "G-1",
    policyholderRelationship: "self",
  },
  documents: [
    { type: "demographics", pageStart: 1, pageEnd: 1, title: "Face sheet" },
    { type: "sleep_study", pageStart: 2, pageEnd: 5, title: "HST report" },
  ],
};

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
  logAuditMock.mockClear();
  runExtractionMock.mockReset();
  splitMock.mockClear();
  fetchMock.mockClear();
  trySetAclMock.mockClear();
  trySetAclMock.mockResolvedValue("/objects/uploads/abc");
  downloadObjectMock.mockClear();
});

describe("GET /admin/referral-reviews", () => {
  it("401s without a session", async () => {
    mockAdmin.current = null;
    expect(
      (await request(makeApp()).get("/admin/referral-reviews")).status,
    ).toBe(401);
  });

  it("403s for a role without conversations.manage", async () => {
    mockAdmin.current = CLINICIAN;
    expect(
      (await request(makeApp()).get("/admin/referral-reviews")).status,
    ).toBe(403);
  });

  it("lists open reviews", async () => {
    stageSupabaseResponse("referral_reviews", "select", {
      data: [reviewRow()],
    });
    const res = await request(makeApp()).get("/admin/referral-reviews");
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0]).toMatchObject({
      id: REVIEW_ID,
      source: "fax",
      status: "extracted",
      hasMedia: true,
    });
  });
});

describe("GET /admin/referral-reviews/:id", () => {
  it("404s on a missing review", async () => {
    stageSupabaseResponse("referral_reviews", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/referral-reviews/${REVIEW_ID}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns the detail with the sending fax number", async () => {
    stageSupabaseResponse("referral_reviews", "select", { data: reviewRow() });
    stageSupabaseResponse("inbound_faxes", "select", {
      data: { from_e164: "+14125550001" },
    });
    const res = await request(makeApp()).get(
      `/admin/referral-reviews/${REVIEW_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.faxFromE164).toBe("+14125550001");
    expect(res.body.extraction.patient.firstName).toBe("Jane");
  });
});

describe("POST /admin/referral-reviews (upload finalize)", () => {
  it("403s for a role without patients.update", async () => {
    mockAdmin.current = CLINICIAN;
    const res = await request(makeApp())
      .post("/admin/referral-reviews")
      .send({ objectPath: "/objects/uploads/abc" });
    expect(res.status).toBe(403);
  });

  it("rejects a non-PDF object", async () => {
    getFileMock.mockResolvedValueOnce({
      bucket: "b",
      path: "p",
      getMetadata: async () => [{ size: 2048, contentType: "image/png" }],
      delete: async () => undefined,
    });
    const res = await request(makeApp())
      .post("/admin/referral-reviews")
      .send({ objectPath: "/objects/uploads/abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("object_invalid_content_type");
  });

  it("opens a pending review for a valid upload", async () => {
    stageSupabaseResponse("referral_reviews", "insert", {
      data: reviewRow({
        source: "upload",
        inbound_fax_id: null,
        status: "pending",
        extraction: null,
      }),
    });
    const res = await request(makeApp())
      .post("/admin/referral-reviews")
      .send({ objectPath: "/objects/uploads/abc" });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("upload");
    expect(res.body.status).toBe("pending");
    // Worker is mocked away (getBoss → null) → not enqueued.
    expect(res.body.enqueued).toBe(false);
    const inserts = getSupabaseWritePayloads("referral_reviews", "insert");
    expect(inserts[0]).toMatchObject({
      source: "upload",
      status: "pending",
      created_by_user_id: "u_admin",
    });
  });
});

describe("POST /admin/referral-reviews/:id/extract", () => {
  it("re-runs extraction and returns the refreshed row", async () => {
    runExtractionMock.mockResolvedValue({ kind: "ran", status: "extracted" });
    stageSupabaseResponse("referral_reviews", "select", { data: reviewRow() });
    const res = await request(makeApp()).post(
      `/admin/referral-reviews/${REVIEW_ID}/extract`,
    );
    expect(res.status).toBe(200);
    expect(runExtractionMock).toHaveBeenCalledWith(REVIEW_ID, { force: true });
    expect(res.body.status).toBe("extracted");
  });

  it("409s on a settled review", async () => {
    runExtractionMock.mockResolvedValue({
      kind: "already_terminal",
      status: "accepted",
    });
    const res = await request(makeApp()).post(
      `/admin/referral-reviews/${REVIEW_ID}/extract`,
    );
    expect(res.status).toBe(409);
  });
});

describe("GET /admin/referral-reviews/:id/duplicates", () => {
  it("returns candidates matched on the extracted phone", async () => {
    stageSupabaseResponse("referral_reviews", "select", { data: reviewRow() });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Jane",
          legal_last_name: "Doe",
          date_of_birth: "1960-02-03",
          email: null,
          phone_e164: "+14155551212",
        },
      ],
    });
    // dob+name pass (same patient, de-duped)
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/admin/referral-reviews/${REVIEW_ID}/duplicates`,
    );
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].matchedOn).toBe("phone");
  });
});

describe("POST /admin/referral-reviews/:id/accept", () => {
  it("403s for a role without patients.update", async () => {
    mockAdmin.current = CLINICIAN;
    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/accept`)
      .send(ACCEPT_BODY);
    expect(res.status).toBe(403);
  });

  it("409s with candidates on a possible duplicate", async () => {
    stageSupabaseResponse("referral_reviews", "select", { data: reviewRow() });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Jane",
          legal_last_name: "Doe",
          date_of_birth: "1960-02-03",
          email: null,
          phone_e164: "+14155551212",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/accept`)
      .send(ACCEPT_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("possible_duplicate");
    expect(res.body.candidates).toHaveLength(1);
    // No patient was created.
    expect(getSupabaseWritePayloads("patients", "insert")).toHaveLength(0);
  });

  it("409s on an already-settled review", async () => {
    stageSupabaseResponse("referral_reviews", "select", {
      data: reviewRow({ status: "accepted" }),
    });
    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/accept`)
      .send(ACCEPT_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("review_settled");
  });

  it("creates the patient, coverage, documents, attaches the fax, settles the review", async () => {
    stageSupabaseResponse("referral_reviews", "select", { data: reviewRow() });
    // duplicate guard: phone pass + dob/name pass, both clean
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "insert", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_coverages", "insert", { data: null });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: DOC_ID },
    });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: DOC_ID },
    });
    stageSupabaseResponse("inbound_faxes", "update", { data: null });
    stageSupabaseResponse("referral_reviews", "update", { data: null });

    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/accept`)
      .send(ACCEPT_BODY);
    expect(res.status).toBe(201);
    expect(res.body.patientId).toBe(PATIENT_ID);
    expect(res.body.documentIds).toHaveLength(2);
    expect(res.body.warnings).toEqual([]);

    const patientInsert = getSupabaseWritePayloads(
      "patients",
      "insert",
    )[0] as Record<string, unknown>;
    expect(patientInsert).toMatchObject({
      legal_first_name: "Jane",
      legal_last_name: "Doe",
      date_of_birth: "1960-02-03",
      phone_e164: "+14155551212",
      email: "jane@example.com",
      status: "active",
      insurance_payer: "Highmark BCBS",
      timezone: "America/New_York", // derived from PA
    });

    const covInsert = getSupabaseWritePayloads(
      "insurance_coverages",
      "insert",
    )[0] as Record<string, unknown>;
    expect(covInsert).toMatchObject({
      patient_id: PATIENT_ID,
      rank: "primary",
      payer_name: "Highmark BCBS",
      member_id: "ABC123",
    });

    // Packet split into the two requested sections, each filed.
    expect(splitMock).toHaveBeenCalledTimes(1);
    const docInserts = getSupabaseWritePayloads(
      "patient_documents",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(docInserts).toHaveLength(2);
    expect(docInserts[0]).toMatchObject({
      patient_id: PATIENT_ID,
      document_type: "referral",
      filename: "Face sheet - Jane Doe.pdf",
    });
    expect(docInserts[1]).toMatchObject({
      patient_id: PATIENT_ID,
      document_type: "sleep_study",
      filename: "HST report - Jane Doe.pdf",
    });

    const faxUpdate = getSupabaseWritePayloads(
      "inbound_faxes",
      "update",
    )[0] as Record<string, unknown>;
    expect(faxUpdate).toMatchObject({
      status: "attached",
      attached_patient_id: PATIENT_ID,
      attached_document_type: "referral",
    });

    const settle = getSupabaseWritePayloads(
      "referral_reviews",
      "update",
    )[0] as Record<string, unknown>;
    expect(settle).toMatchObject({
      status: "accepted",
      created_patient_id: PATIENT_ID,
      accepted_by_user_id: "u_admin",
    });
  });

  it("overrides the duplicate guard when confirmed", async () => {
    stageSupabaseResponse("referral_reviews", "select", { data: reviewRow() });
    // No duplicate selects expected — guard skipped entirely.
    stageSupabaseResponse("patients", "insert", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_coverages", "insert", { data: null });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: DOC_ID },
    });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: DOC_ID },
    });
    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/accept`)
      .send({ ...ACCEPT_BODY, confirmDuplicateOverride: true });
    expect(res.status).toBe(201);
  });

  it("files the whole packet as one referral document for a TIFF source", async () => {
    stageSupabaseResponse("referral_reviews", "select", {
      data: reviewRow({ media_content_type: "image/tiff" }),
    });
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "insert", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_coverages", "insert", { data: null });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: DOC_ID },
    });
    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/accept`)
      .send(ACCEPT_BODY);
    expect(res.status).toBe(201);
    expect(splitMock).not.toHaveBeenCalled();
    const docInserts = getSupabaseWritePayloads(
      "patient_documents",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(docInserts).toHaveLength(1);
    expect(docInserts[0]).toMatchObject({
      document_type: "referral",
      filename: "Referral Packet - Jane Doe.pdf",
      content_type: "image/tiff",
    });
  });
});

describe("POST /admin/referral-reviews/:id/dismiss", () => {
  it("dismisses an open review with a note", async () => {
    stageSupabaseResponse("referral_reviews", "select", {
      data: { id: REVIEW_ID, status: "extracted" },
    });
    stageSupabaseResponse("referral_reviews", "update", { data: null });
    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/dismiss`)
      .send({ note: "Not a referral — marketing fax" });
    expect(res.status).toBe(200);
    const upd = getSupabaseWritePayloads(
      "referral_reviews",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd).toMatchObject({
      status: "dismissed",
      dismiss_note: "Not a referral — marketing fax",
    });
  });

  it("409s on an accepted review", async () => {
    stageSupabaseResponse("referral_reviews", "select", {
      data: { id: REVIEW_ID, status: "accepted" },
    });
    const res = await request(makeApp())
      .post(`/admin/referral-reviews/${REVIEW_ID}/dismiss`)
      .send({});
    expect(res.status).toBe(409);
  });
});
