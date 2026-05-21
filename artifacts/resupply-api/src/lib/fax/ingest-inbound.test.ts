// Tests for the inbound-fax ingest helper.
//
// Coverage:
//   * Insert success → returns { kind: 'inserted', id } and tries
//     to download media when credentials + MediaUrl present.
//   * Insert conflict (Twilio replay) → returns { kind:
//     'already_recorded', id } without re-downloading.
//   * Missing TWILIO_ACCOUNT_SID/AUTH_TOKEN → row created, but
//     media_persisted stays false (skipped).
//   * MediaUrl pointing at a non-Twilio host → rejected, false.
//   * Non-https MediaUrl → rejected, false.
//   * Disallowed content-type response → row created, media rejected.
//   * Oversize payload → row created, media rejected.
//   * Insert DB error other than unique → returns { kind: 'errored' }.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

installSupabaseMock();

// Stub the ObjectStorageService — the ingest helper builds one
// internally when no impl is passed, but we ALWAYS pass one in the
// tests so we can simulate GCS PUT outcomes deterministically.
const uploadUrlStub = "https://storage.example.test/upload";
const objectStorageStub = {
  getObjectEntityUploadURL: vi.fn(async () => uploadUrlStub),
  trySetObjectEntityAclPolicy: vi.fn(async () => "obj-key-12345"),
};

const loggerStub = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { ingestInboundFax } from "./ingest-inbound";
import type { Logger } from "pino";

const baseInput = {
  twilioFaxSid: "FX12345678",
  fromE164: "+12155551234",
  toE164: "+19785551234",
  numPages: 3,
  receivedAt: "2026-05-11T12:00:00Z",
  mediaUrl: "https://api.twilio.com/2010-04-01/Faxes/FX12345678/Media",
  twilioAccountSid: "AC0123456789",
  twilioAuthToken: "auth-token-xyz",
};

beforeEach(() => {
  fetchMock.mockReset();
  objectStorageStub.getObjectEntityUploadURL.mockClear();
  objectStorageStub.trySetObjectEntityAclPolicy.mockClear();
  loggerStub.warn.mockClear();
});

function stageInsertSuccess(id: string) {
  stageSupabaseResponse("inbound_faxes", "insert", {
    data: { id },
    error: null,
  });
}

function stageInsertConflict() {
  stageSupabaseResponse("inbound_faxes", "insert", {
    data: null,
    error: { code: "23505", message: "duplicate key value" },
  });
}

function stageInsertGenericError() {
  stageSupabaseResponse("inbound_faxes", "insert", {
    data: null,
    error: { code: "XX000", message: "internal error" },
  });
}

function stageSelectExisting(id: string) {
  stageSupabaseResponse("inbound_faxes", "select", {
    data: { id },
    error: null,
  });
}

function stagePatch() {
  stageSupabaseResponse("inbound_faxes", "update", {
    data: null,
    error: null,
  });
}

function pdfFetchResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
}

describe("ingestInboundFax — insert behavior", () => {
  it("inserts a new row and reports inserted", async () => {
    stageInsertSuccess("00000000-0000-4000-8000-0000000000aa");
    // Don't bother with media path — null mediaUrl skips it.
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: null },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toEqual({
      kind: "inserted",
      id: "00000000-0000-4000-8000-0000000000aa",
      mediaPersisted: false,
    });
  });

  it("returns already_recorded on unique-violation (Twilio replay)", async () => {
    stageInsertConflict();
    stageSelectExisting("00000000-0000-4000-8000-0000000000bb");
    const result = await ingestInboundFax(
      baseInput,
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result.kind).toBe("already_recorded");
    if (result.kind === "already_recorded") {
      expect(result.id).toBe("00000000-0000-4000-8000-0000000000bb");
    }
    // No fetch attempted — we trust the prior attempt's outcome.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns errored on generic DB failure", async () => {
    stageInsertGenericError();
    const result = await ingestInboundFax(
      baseInput,
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result.kind).toBe("errored");
  });
});

describe("ingestInboundFax — media URL guards", () => {
  it("skips media when twilioAccountSid is null", async () => {
    stageInsertSuccess("id-1");
    const result = await ingestInboundFax(
      { ...baseInput, twilioAccountSid: null },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-Twilio media host", async () => {
    stageInsertSuccess("id-2");
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: "https://evil.example.com/x.pdf" },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.any(Object),
      "fax_inbound_media_url_host_rejected",
    );
  });

  it("rejects non-https media URL", async () => {
    stageInsertSuccess("id-3");
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: "http://api.twilio.com/insecure" },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed media URL", async () => {
    stageInsertSuccess("id-4");
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: "not a url" },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ingestInboundFax — media content gates", () => {
  it("rejects a disallowed content-type", async () => {
    stageInsertSuccess("id-5");
    fetchMock.mockResolvedValueOnce(
      new Response("<html/>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await ingestInboundFax(
      baseInput,
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.any(Object),
      "fax_inbound_media_content_type_rejected",
    );
  });

  it("rejects an empty payload", async () => {
    stageInsertSuccess("id-6");
    fetchMock.mockResolvedValueOnce(pdfFetchResponse(new Uint8Array(0)));
    const result = await ingestInboundFax(
      baseInput,
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.any(Object),
      "fax_inbound_media_size_rejected",
    );
  });

  it("persists and patches the row on a happy-path PDF", async () => {
    stageInsertSuccess("id-7");
    // Twilio media fetch: PDF bytes.
    fetchMock.mockResolvedValueOnce(
      pdfFetchResponse(new Uint8Array([1, 2, 3, 4])),
    );
    // GCS PUT: 200.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    stagePatch();
    const result = await ingestInboundFax(
      baseInput,
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toEqual({
      kind: "inserted",
      id: "id-7",
      mediaPersisted: true,
    });
    expect(objectStorageStub.getObjectEntityUploadURL).toHaveBeenCalledOnce();
    expect(objectStorageStub.trySetObjectEntityAclPolicy).toHaveBeenCalledOnce();
  });
});
