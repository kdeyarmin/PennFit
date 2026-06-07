// Route tests for POST /admin/inbound-faxes/:id/ocr (CSR #C2).
//
// The extraction itself is pinned in lib/inbound-fax/ocr.test.ts; this
// covers the route: gate, media lookup, byte fetch from storage, persist
// of the result, and the fail-soft (offline) pass-through.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

function lastUpdate(table: string): Record<string, unknown> {
  const payloads = getSupabaseWritePayloads(table, "update");
  return (payloads[payloads.length - 1] ?? {}) as Record<string, unknown>;
}

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

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));
vi.mock("../../lib/inbound-fax/ocr", () => ({ extractFaxFields: extractMock }));

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
  return request(makeApp()).post(`/admin/inbound-faxes/${FAX_ID}/ocr`);
}

const EXTRACTED = {
  status: "extracted" as const,
  model: "claude-sonnet-4-6",
  extractedAt: "2026-06-06T00:00:00.000Z",
  fields: {
    documentType: "prescription",
    patientName: "Jane Doe",
    patientDob: null,
    patientPhone: null,
    physicianName: null,
    physicianNpi: null,
    items: [],
    summary: null,
    confidence: "high",
  },
};

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
  downloadObjectMock.mockClear();
  getFileMock.mockClear();
  extractMock.mockReset();
});

describe("POST /admin/inbound-faxes/:id/ocr", () => {
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
      data: { id: FAX_ID, media_object_key: null, media_content_type: null },
    });
    const res = await post();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("media_not_persisted");
  });

  it("extracts, persists the fields, and returns them", async () => {
    stageSupabaseResponse("inbound_faxes", "select", {
      data: {
        id: FAX_ID,
        media_object_key: "obj/key",
        media_content_type: "application/pdf",
        twilio_fax_sid: "FX123",
      },
    });
    stageSupabaseResponse("inbound_faxes", "update", { data: null });
    extractMock.mockResolvedValue(EXTRACTED);

    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("extracted");
    expect(res.body.fields.patientName).toBe("Jane Doe");
    expect(downloadObjectMock).toHaveBeenCalledTimes(1);

    const update = lastUpdate("inbound_faxes");
    expect(update.ocr_status).toBe("extracted");
    expect(update.ocr_extraction).toMatchObject({ patientName: "Jane Doe" });
    expect(update.ocr_extracted_at).toBeTruthy();
  });

  it("passes offline through as a 200 and persists null fields", async () => {
    stageSupabaseResponse("inbound_faxes", "select", {
      data: {
        id: FAX_ID,
        media_object_key: "obj/key",
        media_content_type: "image/png",
        twilio_fax_sid: "FX9",
      },
    });
    stageSupabaseResponse("inbound_faxes", "update", { data: null });
    extractMock.mockResolvedValue({ status: "offline" });

    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("offline");
    expect(res.body.fields).toBeNull();
    const update = lastUpdate("inbound_faxes");
    expect(update.ocr_status).toBe("offline");
    expect(update.ocr_extraction).toBeNull();
  });
});
