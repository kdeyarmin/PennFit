// Tests for the inbound-fax barcode auto-file orchestration. The barcode
// decode + vision scan + object storage are injected stubs; Supabase is the
// shared route-test mock. These pin the deterministic fast-path, the
// match → file → mark-returned → release-hold flow, and every non-match /
// error outcome without a network, model, or image-decode call.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const storageStub = {
  getObjectEntityUploadURL: vi.fn(async () => "https://storage.test/upload"),
  trySetObjectEntityAclPolicy: vi.fn(async () => "chart-object-key"),
};

const loggerStub = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { autoFileSignedFax } from "./auto-file-signed";
import type { TrackingScanResult } from "../inbound-fax/tracking-scan";
import type { Logger } from "pino";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"

/** A signature_tracking DB row as PostgREST returns it. */
function trackingDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "track-1",
    tracking_code: "PFS-ABCD2345",
    document_kind: "prescription_request",
    document_id: "pkt-1",
    patient_id: "pat-1",
    provider_id: "prov-1",
    patient_label: "Jane Doe",
    provider_label: "Dr. House",
    practice_name: "Sleep Clinic",
    title: "Prescription request",
    status: "awaiting_signature",
    delivery_channel: "fax",
    return_fax_e164: "+12155550000",
    sent_count: 1,
    last_sent_at: "2026-06-01T00:00:00Z",
    returned_at: null,
    canceled_at: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

/** Stub vision scan returning a fixed result. */
function scanReturning(result: TrackingScanResult) {
  return vi.fn(async () => result);
}

/** Stub deterministic decode returning a fixed code (or null = miss). */
function decodeReturning(code: string | null) {
  return vi.fn(async () => code);
}

const baseInput = {
  faxId: "00000000-0000-4000-8000-00000000fa01",
  bytes: PDF,
  contentType: "application/pdf",
};

function deps(
  scan: ReturnType<typeof scanReturning>,
  decode: ReturnType<typeof decodeReturning> = decodeReturning(null),
) {
  return {
    logger: loggerStub as unknown as Logger,
    decode: decode as never,
    scan: scan as never,
    storage: storageStub as never,
  };
}

/** Stage the happy-path reads/writes for a matched, outstanding signature. */
function stageHappyPath(row = trackingDbRow()) {
  stageSupabaseResponse("signature_tracking", "select", { data: row });
  stageSupabaseResponse("patient_documents", "insert", {
    data: { id: "doc-1" },
  });
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
}

beforeEach(() => {
  supabaseMock.reset();
  fetchMock.mockReset();
  storageStub.getObjectEntityUploadURL.mockClear();
  storageStub.trySetObjectEntityAclPolicy.mockClear();
  loggerStub.warn.mockClear();
});

describe("autoFileSignedFax — happy path", () => {
  it("files a matched signed fax to the chart and marks it returned (vision)", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageHappyPath();

    const outcome = await autoFileSignedFax(baseInput, deps(scan));

    expect(outcome).toEqual({
      status: "filed",
      trackingCode: "PFS-ABCD2345",
      signatureTrackingId: "track-1",
      chartDocumentId: "doc-1",
    });
    expect(storageStub.getObjectEntityUploadURL).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.test/upload",
      expect.objectContaining({ method: "PUT" }),
    );
    const docInsert = getSupabaseWritePayloads(
      "patient_documents",
      "insert",
    )[0] as Record<string, unknown>;
    expect(docInsert).toMatchObject({
      patient_id: "pat-1",
      object_key: "chart-object-key",
      document_type: "prescription",
    });
    const faxPatch = getSupabaseWritePayloads(
      "inbound_faxes",
      "update",
    )[0] as Record<string, unknown>;
    expect(faxPatch).toMatchObject({
      status: "attached",
      attached_patient_id: "pat-1",
      auto_file_status: "filed",
      tracking_code_detected: "PFS-ABCD2345",
      signature_tracking_id: "track-1",
      chart_document_id: "doc-1",
    });
    expect(getSupabaseCallCount("signature_tracking", "update")).toBe(1);
  });

  it("uses the deterministic barcode decode and skips the vision scan", async () => {
    const scan = scanReturning({ status: "offline" });
    stageHappyPath();

    const outcome = await autoFileSignedFax(
      baseInput,
      deps(scan, decodeReturning("PFS-ABCD2345")),
    );

    expect(outcome.status).toBe("filed");
    // The fast-path hit, so the (paid) vision scan was never called.
    expect(scan).not.toHaveBeenCalled();
  });

  it("satisfies a matching claim paperwork requirement (releases the hold)", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageHappyPath();
    stageSupabaseResponse("claim_paperwork_requirements", "select", {
      data: [{ id: "req-1" }],
    });
    stageSupabaseResponse("claim_paperwork_requirements", "select", {
      data: {
        id: "req-1",
        claim_id: null,
        patient_id: "pat-1",
        requirement_type: "prescription",
        status: "outstanding",
        required: true,
      },
    });
    stageSupabaseResponse("claim_paperwork_requirements", "update", {
      data: {
        id: "req-1",
        claim_id: null,
        patient_id: "pat-1",
        requirement_type: "prescription",
        status: "satisfied",
        required: true,
      },
    });

    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("filed");
    expect(getSupabaseCallCount("claim_paperwork_requirements", "update")).toBe(
      1,
    );
  });
});

describe("autoFileSignedFax — non-match outcomes", () => {
  it("records no_code when neither decode nor scan finds a code", async () => {
    const scan = scanReturning({ status: "not_found" });
    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("no_code");
    expect(storageStub.getObjectEntityUploadURL).not.toHaveBeenCalled();
    const faxPatch = getSupabaseWritePayloads(
      "inbound_faxes",
      "update",
    )[0] as Record<string, unknown>;
    expect(faxPatch.auto_file_status).toBe("no_code");
  });

  it("records offline when the scan is offline", async () => {
    const outcome = await autoFileSignedFax(
      baseInput,
      deps(scanReturning({ status: "offline" })),
    );
    expect(outcome.status).toBe("offline");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records no_match when the code resolves to nothing", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageSupabaseResponse("signature_tracking", "select", { data: null });
    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("no_match");
    expect(storageStub.getObjectEntityUploadURL).not.toHaveBeenCalled();
  });

  it("records already_returned without re-filing", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageSupabaseResponse("signature_tracking", "select", {
      data: trackingDbRow({ status: "returned_signed" }),
    });
    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("already_returned");
    expect(outcome.signatureTrackingId).toBe("track-1");
    expect(storageStub.getObjectEntityUploadURL).not.toHaveBeenCalled();
  });

  it("marks returned but reports no_patient when no patient is linked", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageSupabaseResponse("signature_tracking", "select", {
      data: trackingDbRow({ patient_id: null }),
    });
    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("no_patient");
    expect(getSupabaseCallCount("signature_tracking", "update")).toBe(1);
    expect(storageStub.getObjectEntityUploadURL).not.toHaveBeenCalled();
  });
});

describe("autoFileSignedFax — errors abort to failed", () => {
  it("records failed (not no_match) when the lookup query throws", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageSupabaseResponse("signature_tracking", "select", {
      throws: new Error("db unavailable"),
    });
    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("failed");
    expect(storageStub.getObjectEntityUploadURL).not.toHaveBeenCalled();
  });

  it("aborts to failed (no hold release) when mark-returned throws", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    // Lookup ok, chart write ok, but the mark-returned update fails.
    stageSupabaseResponse("signature_tracking", "select", {
      data: trackingDbRow(),
    });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: "doc-1" },
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    stageSupabaseResponse("signature_tracking", "update", {
      throws: new Error("update failed"),
    });

    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("failed");
    // The chart document was written, but the bill-hold release step was
    // never reached — no requirement lookup/update happened.
    expect(getSupabaseCallCount("patient_documents", "insert")).toBe(1);
    expect(getSupabaseCallCount("claim_paperwork_requirements", "select")).toBe(
      0,
    );
  });
});
