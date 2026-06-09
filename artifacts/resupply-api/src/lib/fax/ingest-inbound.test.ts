// Tests for the inbound-fax ingest helper (Telnyx).
//
// Coverage:
//   * Insert success → returns { kind: 'inserted', id } and tries to
//     download media when a media URL is present.
//   * Insert conflict (Telnyx replay) → returns { kind:
//     'already_recorded', id } without re-downloading.
//   * Null media URL → row created, media_persisted stays false.
//   * media_url on a non-allowed host → rejected, false.
//   * Non-https media_url → rejected, false.
//   * Disallowed content (no PDF/TIFF magic, bad content-type) → rejected.
//   * Oversize / empty payload → rejected.
//   * Insert DB error other than unique → returns { kind: 'errored' }.
//   * S3 octet-stream + PDF magic bytes → accepted (sniff wins).

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

installSupabaseMock();

// Stub the ObjectStorageService — the ingest helper builds one
// internally when no impl is passed, but we ALWAYS pass one in the
// tests so we can simulate object-storage PUT outcomes deterministically.
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

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

const baseInput = {
  telnyxFaxId: "fx-12345678",
  fromE164: "+12155551234",
  toE164: "+19785551234",
  numPages: 3,
  receivedAt: "2026-05-11T12:00:00Z",
  mediaUrl: "https://s3.amazonaws.com/telnyx-fax/fx-12345678.pdf",
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

function mediaResponse(
  bytes: Uint8Array,
  contentType = "application/pdf",
): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("ingestInboundFax — insert behavior", () => {
  it("inserts a new row and reports inserted", async () => {
    stageInsertSuccess("00000000-0000-4000-8000-0000000000aa");
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

  it("returns already_recorded on unique-violation (Telnyx replay)", async () => {
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
  it("skips media when mediaUrl is null", async () => {
    stageInsertSuccess("id-1");
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: null },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-allowed media host", async () => {
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

  it("rejects a non-https media URL", async () => {
    stageInsertSuccess("id-3");
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: "http://s3.amazonaws.com/insecure" },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed media URL", async () => {
    stageInsertSuccess("id-4");
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: "not a url" },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a *.telnyx.com media host", async () => {
    stageInsertSuccess("id-tx");
    fetchMock.mockResolvedValueOnce(mediaResponse(PDF_MAGIC));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    stagePatch();
    const result = await ingestInboundFax(
      { ...baseInput, mediaUrl: "https://media.telnyx.com/fax.pdf" },
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: true });
  });
});

describe("ingestInboundFax — media content gates", () => {
  it("rejects content with no PDF/TIFF magic and a bad content-type", async () => {
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
    fetchMock.mockResolvedValueOnce(mediaResponse(new Uint8Array(0)));
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
    fetchMock.mockResolvedValueOnce(mediaResponse(PDF_MAGIC));
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
    expect(
      objectStorageStub.trySetObjectEntityAclPolicy,
    ).toHaveBeenCalledOnce();
  });

  it("accepts S3 octet-stream when the bytes have PDF magic (sniff wins)", async () => {
    stageInsertSuccess("id-8");
    fetchMock.mockResolvedValueOnce(
      mediaResponse(PDF_MAGIC, "application/octet-stream"),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    stagePatch();
    const result = await ingestInboundFax(
      baseInput,
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    expect(result).toMatchObject({ kind: "inserted", mediaPersisted: true });
  });

  it("does not send an Authorization header (S3 pre-signed URL)", async () => {
    stageInsertSuccess("id-9");
    fetchMock.mockResolvedValueOnce(mediaResponse(PDF_MAGIC));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    stagePatch();
    await ingestInboundFax(
      baseInput,
      loggerStub as unknown as Logger,
      objectStorageStub as never,
    );
    const mediaFetchInit = fetchMock.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const headers = (mediaFetchInit?.headers ?? {}) as Record<string, unknown>;
    expect(headers).not.toHaveProperty("Authorization");
  });
});
