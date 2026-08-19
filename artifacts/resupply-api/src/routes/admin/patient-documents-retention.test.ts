// Route tests for POST /admin/patient-documents/:id/destroy — the one-way
// byte-destruction path.
//
// Coverage (review follow-ups from PR #1272):
//   * the marked-row gate: an unmarked row 409s `not_marked`
//   * legal hold blocks destruction with 409 `legal_hold`
//   * a successful destroy stamps the row AND releases the
//     `object_storage_acls` row (bucket + `/objects/`-stripped path) —
//     without that release the orphan sweep treats the blob as still
//     referenced forever and the deferred erasure never happens
//   * an ACL-release failure is fail-soft: the destroy still 200s and an
//     error is logged for ops
//   * a row with no `/objects/…` key skips the ACL release entirely

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
  getSupabaseCallCount,
  getSupabaseFilterCalls,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next();
  return { adminRateLimit: () => passthrough };
});

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({ logger: loggerMock }));

import router from "./patient-documents-retention";

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const BUCKET = "test-private-bucket";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    patient_id: "22222222-2222-4222-8222-222222222222",
    document_type: "prescription",
    legal_hold: false,
    destroyed_at: null,
    object_key: "/objects/uploads/abc-123",
    retention_marked_at: "2026-08-01T00:00:00Z",
    retention_until_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  vi.clearAllMocks();
  mockAdmin.current = {
    role: "admin",
    email: "admin@example.test",
    userId: "admin-user-1",
  };
  process.env.SUPABASE_STORAGE_BUCKET_PRIVATE = BUCKET;
});

afterEach(() => {
  delete process.env.SUPABASE_STORAGE_BUCKET_PRIVATE;
});

describe("POST /admin/patient-documents/:id/destroy", () => {
  it("409s not_marked when the retention sweep has not flagged the row", async () => {
    stageSupabaseResponse("patient_documents", "select", {
      data: baseRow({ retention_marked_at: null }),
    });
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_marked");
    expect(getSupabaseCallCount("patient_documents", "update")).toBe(0);
  });

  it("409s legal_hold when the document is on hold", async () => {
    stageSupabaseResponse("patient_documents", "select", {
      data: baseRow({ legal_hold: true }),
    });
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("legal_hold");
  });

  it("stamps the row AND releases the object_storage_acls row", async () => {
    stageSupabaseResponse("patient_documents", "select", {
      data: baseRow(),
    });
    stageSupabaseResponse("patient_documents", "update", { data: null });
    stageSupabaseResponse("object_storage_acls", "delete", { data: null });

    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const [updatePayload] = getSupabaseWritePayloads(
      "patient_documents",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(updatePayload?.object_key).toBe("");
    expect(updatePayload?.destroyed_at).toBeTruthy();

    expect(getSupabaseCallCount("object_storage_acls", "delete")).toBe(1);
    const filters = getSupabaseFilterCalls("object_storage_acls", "delete");
    expect(filters).toEqual(
      expect.arrayContaining([
        { verb: "eq", args: ["bucket", BUCKET] },
        { verb: "eq", args: ["path", "uploads/abc-123"] },
      ]),
    );
  });

  it("still 200s (and logs an error) when the ACL release fails", async () => {
    stageSupabaseResponse("patient_documents", "select", {
      data: baseRow(),
    });
    stageSupabaseResponse("patient_documents", "update", { data: null });
    stageSupabaseResponse("object_storage_acls", "delete", {
      error: { message: "boom" },
    });

    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });

    expect(res.status).toBe(200);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "patient_documents.destroy.acl_release_failed",
      }),
      expect.any(String),
    );
  });

  it("skips the ACL release for a row without an /objects/ key", async () => {
    stageSupabaseResponse("patient_documents", "select", {
      data: baseRow({ object_key: "" }),
    });
    stageSupabaseResponse("patient_documents", "update", { data: null });

    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });

    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("object_storage_acls", "delete")).toBe(0);
  });

  it("403s for a non-admin role (destruction is admin-only)", async () => {
    mockAdmin.current = {
      role: "agent",
      email: "agent@example.test",
      userId: "agent-user-1",
    };
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });
    expect(res.status).toBe(403);
  });
});
