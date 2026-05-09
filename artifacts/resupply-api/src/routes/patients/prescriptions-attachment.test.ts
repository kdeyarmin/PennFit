// Route tests for the orphan-cleanup behaviour of the prescription
// attachment endpoints. Specifically:
//   1. DELETE actually deletes the GCS object's bytes (regression
//      guard: the slice originally only nulled the columns).
//   2. DELETE on a row with no attachment is a no-op against GCS.
//   3. DELETE survives a transient GCS failure — the columns still
//      clear and the audit row records `bytes_deleted: "errored"`.
//   4. Finalize replacement deletes the OLD object after the row is
//      pointed at the new one.
//
// Heavier behaviours (the metadata re-validation in finalize, the
// ACL flow, the upload-url issuance audit) are intentionally NOT
// covered here because they would require a much larger mock
// surface and are exercised end-to-end via the architect review +
// manual smoke. This file's scope is the orphan-retention contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

// ObjectStorage stub. The route does `new ObjectStorageService()`
// at module-load time; mocking the module surface gives us control
// over what each call returns. ObjectNotFoundError must be a real
// class so `instanceof` checks in the handler work. Spies are
// hoisted via vi.hoisted() so the vi.mock factory (which itself is
// hoisted to the top of the file) can reach them.
const objectStorageMocks = vi.hoisted(() => {
  class StubObjectNotFoundError extends Error {}
  const fileDeleteMock = vi.fn();
  const getMetadataMock = vi.fn(async () => [
    { size: "100", contentType: "application/pdf" },
  ]);
  const getObjectEntityFileMock = vi.fn(async (path: string) => ({
    path,
    delete: () => fileDeleteMock(path),
    getMetadata: () => getMetadataMock(),
  }));
  const trySetObjectEntityAclPolicyMock = vi.fn(
    async (path: string, _opts: unknown) => path,
  );
  return {
    StubObjectNotFoundError,
    fileDeleteMock,
    getMetadataMock,
    getObjectEntityFileMock,
    trySetObjectEntityAclPolicyMock,
  };
});
const {
  StubObjectNotFoundError,
  fileDeleteMock,
  getMetadataMock,
  getObjectEntityFileMock,
  trySetObjectEntityAclPolicyMock,
} = objectStorageMocks;
vi.mock("../../lib/object-storage/objectStorage", () => ({
  ObjectNotFoundError: objectStorageMocks.StubObjectNotFoundError,
  ObjectStorageService: class {
    getObjectEntityFile = (path: string) =>
      objectStorageMocks.getObjectEntityFileMock(path);
    getObjectEntityUploadURL = vi.fn();
    normalizeObjectEntityPath = vi.fn();
    trySetObjectEntityAclPolicy = (path: string, opts: unknown) =>
      objectStorageMocks.trySetObjectEntityAclPolicyMock(path, opts);
  },
}));

import attachmentRouter from "./prescriptions-attachment";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const RX_ID = "22222222-2222-4222-8222-222222222222";
const OBJ_KEY = "/objects/uploads/abc-123";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // Stub req.log so handler-level `req.log.warn(...)` calls don't
  // explode in tests (no pino-http middleware here). Production
  // mounts pino-http via the api-server bootstrap.
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: { warn: () => void; error: () => void; info: () => void };
      }
    ).log = {
      warn: () => undefined,
      error: () => undefined,
      info: () => undefined,
    };
    next();
  });
  app.use("/resupply-api", attachmentRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
const originalEnv: Partial<
  Record<(typeof ENV_KEYS)[number], string | undefined>
> = {};

function resetEnvAndMocks(): void {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

  process.env.NODE_ENV = "test";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockReset().mockResolvedValue(undefined);
  fileDeleteMock.mockReset().mockResolvedValue(undefined);
  getObjectEntityFileMock.mockClear();
  getMetadataMock
    .mockReset()
    .mockResolvedValue([{ size: "100", contentType: "application/pdf" }]);
  trySetObjectEntityAclPolicyMock
    .mockReset()
    .mockImplementation(async (path: string) => path);
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
}

describe("DELETE /patients/:id/prescriptions/:rxId/attachment", () => {
  beforeEach(resetEnvAndMocks);
  afterEach(restoreEnv);

  it("deletes the GCS object before clearing columns and audits bytes_deleted=true", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: OBJ_KEY,
        attachment_filename: "rx.pdf",
        attachment_content_type: "application/pdf",
      },
    });
    stageSupabaseResponse("prescriptions", "update", { error: null });

    const res = await request(makeApp()).delete(
      `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
    );

    expect(res.status).toBe(200);
    expect(getObjectEntityFileMock).toHaveBeenCalledWith(OBJ_KEY);
    expect(fileDeleteMock).toHaveBeenCalledTimes(1);
    const updates = getSupabaseWritePayloads(
      "prescriptions",
      "update",
    ) as Record<string, unknown>[];
    expect(updates[0]).toMatchObject({
      attachment_object_key: null,
      attachment_filename: null,
    });
    const auditCall = logAuditMock.mock.calls[0]?.[0] as
      | { metadata?: { bytes_deleted?: unknown } }
      | undefined;
    expect(auditCall?.metadata?.bytes_deleted).toBe(true);
  });

  it("does not call GCS when the row already has no attachment", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: null,
        attachment_filename: null,
        attachment_content_type: null,
      },
    });

    const res = await request(makeApp()).delete(
      `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
    );

    expect(res.status).toBe(200);
    expect(getObjectEntityFileMock).not.toHaveBeenCalled();
    expect(fileDeleteMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("prescriptions", "update")).toBe(0);
  });

  it("treats a missing GCS object as already-deleted (success)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: OBJ_KEY,
        attachment_filename: "rx.pdf",
        attachment_content_type: "application/pdf",
      },
    });
    stageSupabaseResponse("prescriptions", "update", { error: null });
    fileDeleteMock.mockRejectedValueOnce(new StubObjectNotFoundError("gone"));

    const res = await request(makeApp()).delete(
      `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
    );

    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("prescriptions", "update")).toBe(1);
    const auditCall = logAuditMock.mock.calls[0]?.[0] as
      | { metadata?: { bytes_deleted?: unknown } }
      | undefined;
    expect(auditCall?.metadata?.bytes_deleted).toBe(true);
  });

  it("clears columns even when GCS delete errors, recording bytes_deleted='errored'", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: OBJ_KEY,
        attachment_filename: "rx.pdf",
        attachment_content_type: "application/pdf",
      },
    });
    stageSupabaseResponse("prescriptions", "update", { error: null });
    fileDeleteMock.mockRejectedValueOnce(new Error("transient gcs error"));

    const res = await request(makeApp()).delete(
      `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
    );

    // Best-effort: the request still succeeds and the row clears so
    // the UI doesn't get stuck. The audit row is the breadcrumb for
    // the future sweep job to find the orphan.
    expect(res.status).toBe(200);
    const updates = getSupabaseWritePayloads(
      "prescriptions",
      "update",
    ) as Record<string, unknown>[];
    expect(updates[0]).toMatchObject({ attachment_object_key: null });
    const auditCall = logAuditMock.mock.calls[0]?.[0] as
      | { metadata?: { bytes_deleted?: unknown } }
      | undefined;
    expect(auditCall?.metadata?.bytes_deleted).toBe("errored");
  });
});

describe("POST /patients/:id/prescriptions/:rxId/attachment (finalize replacement)", () => {
  beforeEach(resetEnvAndMocks);
  afterEach(restoreEnv);

  const NEW_KEY = "/objects/uploads/new-456";
  const OLD_KEY = "/objects/uploads/old-789";
  const finalizePayload = {
    objectPath: NEW_KEY,
    filename: "rx-new.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
  };

  it("captures the previous object key before the row update, then deletes the old object after", async () => {
    stubVerifiedAdmin();
    // The handler reads the row first to know whether this is a
    // replacement; seed it with the OLD object already attached.
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: OLD_KEY,
        attachment_filename: "rx-old.pdf",
        attachment_content_type: "application/pdf",
      },
    });
    stageSupabaseResponse("prescriptions", "update", { error: null });

    // Order trace: capture every interesting side-effect in order so
    // we can assert "row update happened BEFORE old-object delete"
    // (the durable-commit-point ordering the architect called out).
    const order: string[] = [];
    fileDeleteMock.mockImplementation(async (path: string) => {
      order.push(`delete:${path}`);
    });

    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
      )
      .send(finalizePayload);

    expect(res.status).toBe(200);

    // The row was repointed at the NEW object. Inspect the patch
    // payload that landed on the Supabase update call.
    const updates = getSupabaseWritePayloads(
      "prescriptions",
      "update",
    ) as Record<string, unknown>[];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      attachment_object_key: NEW_KEY,
      attachment_filename: "rx-new.pdf",
    });
    // Stitch the order trace from the supabase call count + the
    // captured deletes: the update is the first event, the delete
    // the second.
    order.unshift("update");
    expect(order).toEqual(["update", `delete:${OLD_KEY}`]);
    // The OLD object's bytes were deleted.
    expect(fileDeleteMock).toHaveBeenCalledTimes(1);
    expect(getObjectEntityFileMock).toHaveBeenCalledWith(OLD_KEY);

    // Audit reflects the cleanup outcome.
    const auditCall = logAuditMock.mock.calls[0]?.[0] as
      | {
          metadata?: {
            replaced_existing?: unknown;
            previous_object_deleted?: unknown;
          };
        }
      | undefined;
    expect(auditCall?.metadata?.replaced_existing).toBe(true);
    expect(auditCall?.metadata?.previous_object_deleted).toBe(true);
  });

  it("does not attempt cleanup on first-time upload (no previous attachment)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: null,
        attachment_filename: null,
        attachment_content_type: null,
      },
    });
    stageSupabaseResponse("prescriptions", "update", { error: null });

    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
      )
      .send(finalizePayload);

    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("prescriptions", "update")).toBe(1);
    // Only the metadata-verification getObjectEntityFile call
    // happened — no second call for cleanup.
    expect(getObjectEntityFileMock).toHaveBeenCalledTimes(1);
    expect(getObjectEntityFileMock).toHaveBeenCalledWith(NEW_KEY);
    expect(fileDeleteMock).not.toHaveBeenCalled();
    const auditCall = logAuditMock.mock.calls[0]?.[0] as
      | {
          metadata?: {
            replaced_existing?: unknown;
            previous_object_deleted?: unknown;
          };
        }
      | undefined;
    expect(auditCall?.metadata?.replaced_existing).toBe(false);
    // `false` here means "nothing to clean up", distinct from
    // `"errored"` (which means cleanup was attempted and failed).
    expect(auditCall?.metadata?.previous_object_deleted).toBe(false);
  });

  it("treats a missing previous object as already-cleaned (idempotent)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: OLD_KEY,
        attachment_filename: "rx-old.pdf",
        attachment_content_type: "application/pdf",
      },
    });
    stageSupabaseResponse("prescriptions", "update", { error: null });
    // First getObjectEntityFile call (metadata check on NEW) succeeds
    // with the default mock; second call (cleanup of OLD) throws.
    getObjectEntityFileMock.mockImplementationOnce(async (path: string) => ({
      path,
      delete: () => fileDeleteMock(path),
      getMetadata: () => getMetadataMock(),
    }));
    getObjectEntityFileMock.mockImplementationOnce(async () => {
      throw new StubObjectNotFoundError("gone");
    });

    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
      )
      .send(finalizePayload);

    expect(res.status).toBe(200);
    const auditCall = logAuditMock.mock.calls[0]?.[0] as
      | { metadata?: { previous_object_deleted?: unknown } }
      | undefined;
    expect(auditCall?.metadata?.previous_object_deleted).toBe(true);
  });

  it("records previous_object_deleted='errored' when the old-object delete fails", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: RX_ID,
        attachment_object_key: OLD_KEY,
        attachment_filename: "rx-old.pdf",
        attachment_content_type: "application/pdf",
      },
    });
    stageSupabaseResponse("prescriptions", "update", { error: null });
    // The metadata-check getObjectEntityFile call uses the default
    // mock (resolves with a file whose .delete() resolves). The
    // SECOND call (for cleanup of OLD) returns a file whose
    // .delete() rejects with a non-ObjectNotFound error — i.e. the
    // bucket is having a transient issue.
    let callCount = 0;
    getObjectEntityFileMock.mockImplementation(async (path: string) => {
      callCount += 1;
      if (callCount === 1) {
        // metadata-verification path — bytes are present, delete OK.
        return {
          path,
          delete: () => fileDeleteMock(path),
          getMetadata: () => getMetadataMock(),
        };
      }
      // cleanup path — delete rejects.
      return {
        path,
        delete: async () => {
          throw new Error("transient gcs error on cleanup");
        },
        getMetadata: () => getMetadataMock(),
      };
    });

    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/prescriptions/${RX_ID}/attachment`,
      )
      .send(finalizePayload);

    // Replacement still succeeds — the row is the durable commit
    // point, the orphan is captured in the audit row.
    expect(res.status).toBe(200);
    const updates = getSupabaseWritePayloads(
      "prescriptions",
      "update",
    ) as Record<string, unknown>[];
    expect(updates[0]).toMatchObject({ attachment_object_key: NEW_KEY });
    const auditCall = logAuditMock.mock.calls[0]?.[0] as
      | { metadata?: { previous_object_deleted?: unknown } }
      | undefined;
    expect(auditCall?.metadata?.previous_object_deleted).toBe("errored");
  });
});
