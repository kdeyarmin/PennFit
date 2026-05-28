// Tests for the inbound-webhook dispatcher sweep.
//
// Coverage focuses on the state-machine seams (claim / mark-processed
// / mark-rejected / mark-retry / unknown-source / dispatcher-throw)
// without exercising the underlying per-source dispatchers (those
// have their own suites).

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { dispatchParachuteMock, dispatchEhrFhirMock } = vi.hoisted(() => ({
  dispatchParachuteMock: vi.fn(),
  dispatchEhrFhirMock: vi.fn(),
}));
vi.mock("../../lib/inbound-dispatchers/parachute", () => ({
  dispatchParachute: dispatchParachuteMock,
}));
vi.mock("../../lib/inbound-dispatchers/ehr-fhir", () => ({
  dispatchEhrFhir: dispatchEhrFhirMock,
}));

import { runInboundWebhookDispatcher } from "./inbound-webhook-dispatch";

const WH_ROW = {
  id: "wh_1",
  source: "parachute",
  payload_json: { foo: "bar" },
  verification_headers_json: {},
  signature_verified: true,
};

beforeEach(() => {
  supabaseMock.reset();
  dispatchParachuteMock.mockReset();
  dispatchEhrFhirMock.mockReset();
});

describe("runInboundWebhookDispatcher", () => {
  it("returns zeros when there are no pending rows", async () => {
    // lease-recovery sweep
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });
    // pending scan
    stageSupabaseResponse("inbound_webhooks", "select", { data: [] });
    const stats = await runInboundWebhookDispatcher();
    expect(stats).toEqual({
      scanned: 0,
      processed: 0,
      rejected: 0,
      retried: 0,
      skipped_unknown_source: 0,
    });
  });

  it("dispatches a parachute row and marks it processed on ok", async () => {
    // lease recovery
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });
    // candidate scan
    stageSupabaseResponse("inbound_webhooks", "select", {
      data: [{ id: "wh_1" }],
    });
    // atomic claim
    stageSupabaseResponse("inbound_webhooks", "update", {
      data: [WH_ROW],
    });
    // mark-processed
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });

    dispatchParachuteMock.mockResolvedValueOnce({
      ok: true,
      referralId: "ref_1",
      deduped: false,
    });

    const stats = await runInboundWebhookDispatcher();
    expect(stats).toMatchObject({ scanned: 1, processed: 1 });
    expect(dispatchParachuteMock).toHaveBeenCalledTimes(1);

    const writes = getSupabaseWritePayloads("inbound_webhooks", "update");
    // Last update was mark-processed
    const processed = writes[writes.length - 1] as {
      status: string;
      processed_at: string;
    };
    expect(processed.status).toBe("processed");
    expect(processed.processed_at).toBeTruthy();
  });

  it("marks permanent failures as rejected", async () => {
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });
    stageSupabaseResponse("inbound_webhooks", "select", {
      data: [{ id: "wh_1" }],
    });
    stageSupabaseResponse("inbound_webhooks", "update", { data: [WH_ROW] });
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });

    dispatchParachuteMock.mockResolvedValueOnce({
      ok: false,
      permanent: true,
      reason: "parse_invalid_shape",
    });

    const stats = await runInboundWebhookDispatcher();
    expect(stats).toMatchObject({ scanned: 1, rejected: 1 });

    const writes = getSupabaseWritePayloads("inbound_webhooks", "update");
    const reject = writes[writes.length - 1] as {
      status: string;
      processing_error: string;
    };
    expect(reject.status).toBe("rejected");
    expect(reject.processing_error).toBe("parse_invalid_shape");
  });

  it("marks transient failures as processing_failed (retry)", async () => {
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });
    stageSupabaseResponse("inbound_webhooks", "select", {
      data: [{ id: "wh_1" }],
    });
    stageSupabaseResponse("inbound_webhooks", "update", { data: [WH_ROW] });
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });

    dispatchParachuteMock.mockResolvedValueOnce({
      ok: false,
      permanent: false,
      reason: "parachute_unconfigured",
    });

    const stats = await runInboundWebhookDispatcher();
    expect(stats).toMatchObject({ scanned: 1, retried: 1 });

    const writes = getSupabaseWritePayloads("inbound_webhooks", "update");
    const retry = writes[writes.length - 1] as { status: string };
    expect(retry.status).toBe("processing_failed");
  });

  it("treats a dispatcher throw as retry", async () => {
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });
    stageSupabaseResponse("inbound_webhooks", "select", {
      data: [{ id: "wh_1" }],
    });
    stageSupabaseResponse("inbound_webhooks", "update", { data: [WH_ROW] });
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });

    dispatchParachuteMock.mockRejectedValueOnce(new Error("boom"));

    const stats = await runInboundWebhookDispatcher();
    expect(stats).toMatchObject({ scanned: 1, retried: 1 });
    const writes = getSupabaseWritePayloads("inbound_webhooks", "update");
    const retry = writes[writes.length - 1] as {
      status: string;
      processing_error: string;
    };
    expect(retry.status).toBe("processing_failed");
    expect(retry.processing_error).toBe("boom");
  });

  it("counts unknown-source rows as skipped + marks for triage", async () => {
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });
    stageSupabaseResponse("inbound_webhooks", "select", {
      data: [{ id: "wh_x" }],
    });
    stageSupabaseResponse("inbound_webhooks", "update", {
      data: [{ ...WH_ROW, id: "wh_x", source: "made_up_source" }],
    });
    // mark-retry for unknown source
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });

    const stats = await runInboundWebhookDispatcher();
    expect(stats).toMatchObject({ scanned: 1, skipped_unknown_source: 1 });
    expect(dispatchParachuteMock).not.toHaveBeenCalled();
    expect(dispatchEhrFhirMock).not.toHaveBeenCalled();

    const writes = getSupabaseWritePayloads("inbound_webhooks", "update");
    const retry = writes[writes.length - 1] as { processing_error: string };
    expect(retry.processing_error).toContain("no_dispatcher_for_source");
  });

  it("routes ehr_fhir_* sources to dispatchEhrFhir", async () => {
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });
    stageSupabaseResponse("inbound_webhooks", "select", {
      data: [{ id: "wh_f" }],
    });
    stageSupabaseResponse("inbound_webhooks", "update", {
      data: [{ ...WH_ROW, id: "wh_f", source: "ehr_fhir_test" }],
    });
    stageSupabaseResponse("inbound_webhooks", "update", { data: null });

    dispatchEhrFhirMock.mockResolvedValueOnce({
      ok: true,
      referralId: "ref_2",
      deduped: false,
    });

    const stats = await runInboundWebhookDispatcher();
    expect(stats).toMatchObject({ processed: 1 });
    expect(dispatchEhrFhirMock).toHaveBeenCalledTimes(1);
    expect(dispatchParachuteMock).not.toHaveBeenCalled();
  });
});
