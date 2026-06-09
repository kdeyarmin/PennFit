// Tests for the inbound-fax barcode auto-file orchestration. The barcode
// scan and object storage are injected stubs; Supabase is the shared
// route-test mock. These pin the match → file-to-chart → mark-returned →
// release-bill-hold flow and every non-match outcome without a network or
// model call.

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

/** Stub scan returning a fixed result. */
function scanReturning(result: TrackingScanResult) {
  return vi.fn(async () => result);
}

const baseInput = {
  faxId: "00000000-0000-4000-8000-00000000fa01",
  bytes: PDF,
  contentType: "application/pdf",
};

function deps(scan: ReturnType<typeof scanReturning>) {
  return {
    logger: loggerStub as unknown as Logger,
    scan: scan as never,
    storage: storageStub as never,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  fetchMock.mockReset();
  storageStub.getObjectEntityUploadURL.mockClear();
  storageStub.trySetObjectEntityAclPolicy.mockClear();
  loggerStub.warn.mockClear();
});

describe("autoFileSignedFax — happy path", () => {
  it("files a matched signed fax to the chart and marks it returned", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageSupabaseResponse("signature_tracking", "select", {
      data: trackingDbRow(),
    });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: "doc-1" },
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const outcome = await autoFileSignedFax(baseInput, deps(scan));

    expect(outcome).toEqual({
      status: "filed",
      trackingCode: "PFS-ABCD2345",
      signatureTrackingId: "track-1",
      chartDocumentId: "doc-1",
    });
    // Copied the bytes to a new chart object and PUT them.
    expect(storageStub.getObjectEntityUploadURL).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.test/upload",
      expect.objectContaining({ method: "PUT" }),
    );

    // The chart document was filed for the right patient + type.
    const docInsert = getSupabaseWritePayloads(
      "patient_documents",
      "insert",
    )[0] as Record<string, unknown>;
    expect(docInsert).toMatchObject({
      patient_id: "pat-1",
      object_key: "chart-object-key",
      document_type: "prescription",
    });

    // The fax row was attached + stamped filed.
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

    // The signature was marked returned (signature_tracking update).
    expect(getSupabaseCallCount("signature_tracking", "update")).toBe(1);
  });

  it("satisfies a matching claim paperwork requirement (releases the hold)", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageSupabaseResponse("signature_tracking", "select", {
      data: trackingDbRow(),
    });
    stageSupabaseResponse("patient_documents", "insert", {
      data: { id: "doc-1" },
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // One outstanding requirement sourced from this packet → satisfied.
    stageSupabaseResponse("claim_paperwork_requirements", "select", {
      data: [{ id: "req-1" }],
    });
    // satisfyRequirement reads the row then updates it.
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
  it("records no_code when the scan finds no barcode", async () => {
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
    const scan = scanReturning({ status: "offline" });
    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("offline");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records no_match when the code resolves to nothing", async () => {
    const scan = scanReturning({ status: "found", code: "PFS-ABCD2345" });
    stageSupabaseResponse("signature_tracking", "select", { data: null });
    const outcome = await autoFileSignedFax(baseInput, deps(scan));
    expect(outcome.status).toBe("no_match");
    expect(storageStub.getObjectEntityUploadURL).not.toHaveBeenCalled();
    const faxPatch = getSupabaseWritePayloads(
      "inbound_faxes",
      "update",
    )[0] as Record<string, unknown>;
    expect(faxPatch).toMatchObject({
      auto_file_status: "no_match",
      tracking_code_detected: "PFS-ABCD2345",
    });
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
    // Signature still marked returned (it genuinely came back)…
    expect(getSupabaseCallCount("signature_tracking", "update")).toBe(1);
    // …but nothing was filed to a chart.
    expect(storageStub.getObjectEntityUploadURL).not.toHaveBeenCalled();
  });
});
