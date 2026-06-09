// Route tests for POST /admin/inbound-faxes/:id/auto-file — the manual
// barcode auto-file trigger. The auto-file routine itself is pinned in
// lib/fax/auto-file-signed.test.ts; this covers the route: gate, media
// lookup, the already-filed short-circuit, the byte fetch, and surfacing
// the outcome.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { downloadObjectMock, getFileMock, ObjectNotFoundErrorClass } =
  vi.hoisted(() => ({
    downloadObjectMock: vi.fn(async (_file?: unknown) => ({
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    })),
    getFileMock: vi.fn(async (_path?: unknown) => ({ bucket: "b", path: "p" })),
    ObjectNotFoundErrorClass: class ObjectNotFoundError extends Error {
      constructor() {
        super("object_not_found");
        this.name = "ObjectNotFoundError";
      }
    },
  }));

vi.mock("../../lib/object-storage/objectStorage", () => ({
  ObjectNotFoundError: ObjectNotFoundErrorClass,
  ObjectStorageService: class {
    getObjectEntityFile = (path: string) => getFileMock(path);
    downloadObject = (file: unknown) => downloadObjectMock(file);
  },
}));

const { autoFileMock } = vi.hoisted(() => ({ autoFileMock: vi.fn() }));
vi.mock("../../lib/fax/auto-file-signed", () => ({
  autoFileSignedFax: autoFileMock,
}));

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  adminReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import inboundFaxesRouter from "./inbound-faxes";

const FAX_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN: MockAdminCtx = {
  userId: "u",
  email: "csr@x.example.com",
  role: "agent",
  granularRole: "supervisor",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(inboundFaxesRouter);
  return app;
}

function post() {
  return request(makeApp()).post(`/admin/inbound-faxes/${FAX_ID}/auto-file`);
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
  downloadObjectMock.mockClear();
  getFileMock.mockClear();
  autoFileMock.mockReset();
});

describe("POST /admin/inbound-faxes/:id/auto-file", () => {
  it("401s without a session", async () => {
    mockAdmin.current = null;
    expect((await post()).status).toBe(401);
  });

  it("404s when the fax row is missing", async () => {
    stageSupabaseResponse("inbound_faxes", "select", { data: null });
    expect((await post()).status).toBe(404);
  });

  it("404s media_not_persisted when there's no media key", async () => {
    stageSupabaseResponse("inbound_faxes", "select", {
      data: { id: FAX_ID, media_object_key: null, auto_file_status: null },
    });
    const res = await post();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("media_not_persisted");
    expect(autoFileMock).not.toHaveBeenCalled();
  });

  it("short-circuits an already-filed fax without re-filing", async () => {
    stageSupabaseResponse("inbound_faxes", "select", {
      data: {
        id: FAX_ID,
        media_object_key: "obj/key",
        media_content_type: "application/pdf",
        auto_file_status: "filed",
      },
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "filed", alreadyFiled: true });
    expect(downloadObjectMock).not.toHaveBeenCalled();
    expect(autoFileMock).not.toHaveBeenCalled();
  });

  it("files on a confident match and returns the outcome", async () => {
    stageSupabaseResponse("inbound_faxes", "select", {
      data: {
        id: FAX_ID,
        media_object_key: "obj/key",
        media_content_type: "application/pdf",
        auto_file_status: null,
        twilio_fax_sid: "FX1",
      },
    });
    autoFileMock.mockResolvedValue({
      status: "filed",
      trackingCode: "PFS-ABCD2345",
      signatureTrackingId: "track-1",
      chartDocumentId: "doc-1",
    });

    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "filed",
      trackingCode: "PFS-ABCD2345",
      chartDocumentId: "doc-1",
    });
    expect(downloadObjectMock).toHaveBeenCalledTimes(1);
    expect(autoFileMock).toHaveBeenCalledTimes(1);
    const arg = autoFileMock.mock.calls[0][0];
    expect(arg.faxId).toBe(FAX_ID);
    expect(arg.contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(arg.bytes)).toBe(true);
  });

  it("surfaces a non-match outcome (no_match)", async () => {
    stageSupabaseResponse("inbound_faxes", "select", {
      data: {
        id: FAX_ID,
        media_object_key: "obj/key",
        media_content_type: "application/pdf",
        auto_file_status: null,
        twilio_fax_sid: "FX2",
      },
    });
    autoFileMock.mockResolvedValue({
      status: "no_match",
      trackingCode: "PFS-ABCD2345",
      signatureTrackingId: null,
      chartDocumentId: null,
    });

    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_match");
    expect(res.body.chartDocumentId).toBeNull();
  });

  it("defaults a missing content type to application/pdf", async () => {
    stageSupabaseResponse("inbound_faxes", "select", {
      data: {
        id: FAX_ID,
        media_object_key: "obj/key",
        media_content_type: null,
        auto_file_status: null,
        twilio_fax_sid: "FX3",
      },
    });
    autoFileMock.mockResolvedValue({
      status: "no_code",
      trackingCode: null,
      signatureTrackingId: null,
      chartDocumentId: null,
    });

    await post();
    expect(autoFileMock.mock.calls[0][0].contentType).toBe("application/pdf");
  });
});
