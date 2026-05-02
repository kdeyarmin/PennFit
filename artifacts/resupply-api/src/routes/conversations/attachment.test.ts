// Route tests for GET /conversations/:id/messages/:messageId/attachments/:attachmentId
//
// Asserts:
//   - 401 with no admin session
//   - 404 when the (conversation, message, attachment) tuple doesn't
//     match a row (predicate mismatch is indistinguishable from
//     "doesn't exist")
//   - happy path streams bytes with the expected content-disposition
//     and writes a conversation.attachment.download audit row
//   - 404 when GCS reports the object missing (sweep race)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// drizzle stub — single SELECT with INNER JOINs.
const selectQueue: unknown[] = [];
const dbStub = {
  select: vi.fn(() => {
    const obj: Record<string, unknown> = {
      from: () => obj,
      innerJoin: () => obj,
      where: () => obj,
      limit: () =>
        Promise.resolve(selectQueue.shift() ?? []),
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));
vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

// ObjectStorageService stub. The handler instantiates the service
// at module-load (one shared instance). Spies hoisted so the mock
// factory can reach them.
const objectStorageMocks = vi.hoisted(() => {
  class StubObjectNotFoundError extends Error {}
  const getObjectEntityFileMock = vi.fn();
  const downloadObjectMock = vi.fn();
  return {
    StubObjectNotFoundError,
    getObjectEntityFileMock,
    downloadObjectMock,
  };
});
vi.mock("../../lib/object-storage/objectStorage", () => ({
  ObjectNotFoundError: objectStorageMocks.StubObjectNotFoundError,
  ObjectStorageService: class {
    getObjectEntityFile = (path: string) =>
      objectStorageMocks.getObjectEntityFileMock(path);
    downloadObject = (file: unknown, ttl: number) =>
      objectStorageMocks.downloadObjectMock(file, ttl);
  },
}));
const {
  StubObjectNotFoundError,
  getObjectEntityFileMock,
  downloadObjectMock,
} = objectStorageMocks;

import attachmentRouter from "./attachment";

const ALLOWED_EMAIL = "ops@penn.example.com";
const CONV_ID = "11111111-1111-4111-8111-111111111111";
const MSG_ID = "22222222-2222-4222-8222-222222222222";
const ATT_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", attachmentRouter);
  return app;
}
function stubAdmin(): void {
  mockAdmin.current = { userId: "user_op", email: ALLOWED_EMAIL, role: "admin" };
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("GET /conversations/:id/messages/:messageId/attachments/:attachmentId", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    selectQueue.length = 0;
    mockAdmin.current = null;
    dbStub.select.mockClear();
    logAuditMock.mockReset().mockResolvedValue(undefined);
    getObjectEntityFileMock.mockReset();
    downloadObjectMock.mockReset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 without an admin session", async () => {
    const res = await request(makeApp()).get(
      `/resupply-api/conversations/${CONV_ID}/messages/${MSG_ID}/attachments/${ATT_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the predicate doesn't match a row", async () => {
    stubAdmin();
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/resupply-api/conversations/${CONV_ID}/messages/${MSG_ID}/attachments/${ATT_ID}`,
    );
    expect(res.status).toBe(404);
    expect(getObjectEntityFileMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("streams bytes, sets inline content-disposition, and writes audit", async () => {
    stubAdmin();
    selectQueue.push([
      {
        objectKey: "/objects/uploads/abc",
        filename: "mms-MEdef.png",
        contentType: "image/png",
      },
    ]);
    const fakeFile = { name: "abc" };
    getObjectEntityFileMock.mockResolvedValue(fakeFile);
    // Hand-build a Web Response with a small body — the handler
    // pipes response.body through Readable.fromWeb.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const webResp = new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    downloadObjectMock.mockResolvedValue(webResp);

    const res = await request(makeApp()).get(
      `/resupply-api/conversations/${CONV_ID}/messages/${MSG_ID}/attachments/${ATT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("inline;");
    expect(res.headers["content-disposition"]).toContain("mms-MEdef.png");
    expect(res.body).toBeInstanceOf(Buffer);
    expect((res.body as Buffer).length).toBeGreaterThan(0);
    expect(downloadObjectMock).toHaveBeenCalledWith(fakeFile, 300);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("conversation.attachment.download");
    expect(audit.targetTable).toBe("message_attachments");
    expect(audit.targetId).toBe(ATT_ID);
    expect(audit.metadata.conversation_id).toBe(CONV_ID);
    expect(audit.metadata.message_id).toBe(MSG_ID);
    expect(audit.metadata.content_type).toBe("image/png");
    // PHI scrub: no filename or object key in audit metadata.
    expect(JSON.stringify(audit.metadata)).not.toContain("MEdef.png");
    expect(JSON.stringify(audit.metadata)).not.toContain(
      "/objects/uploads/abc",
    );
  });

  it("returns 404 when GCS reports the object missing", async () => {
    stubAdmin();
    selectQueue.push([
      {
        objectKey: "/objects/uploads/gone",
        filename: "mms.png",
        contentType: "image/png",
      },
    ]);
    getObjectEntityFileMock.mockRejectedValue(new StubObjectNotFoundError());
    const res = await request(makeApp()).get(
      `/resupply-api/conversations/${CONV_ID}/messages/${MSG_ID}/attachments/${ATT_ID}`,
    );
    expect(res.status).toBe(404);
    expect(downloadObjectMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
