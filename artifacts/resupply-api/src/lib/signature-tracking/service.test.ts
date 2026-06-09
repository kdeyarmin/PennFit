import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

import {
  generateTrackingCode,
  listOutstandingSignatures,
  normalizeTrackingCode,
  registerSignatureTracking,
} from "./service";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

const supabaseMock = installSupabaseMock();
beforeEach(() => supabaseMock.reset());

describe("generateTrackingCode", () => {
  it("is PFS- + 8 unambiguous chars (no 0/O/1/I/L)", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateTrackingCode()).toMatch(
        /^PFS-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/,
      );
    }
  });
});

describe("normalizeTrackingCode", () => {
  it("uppercases, strips spaces/dashes, and re-applies the prefix", () => {
    expect(normalizeTrackingCode("pfs-7f3k2q9x")).toBe("PFS-7F3K2Q9X");
    expect(normalizeTrackingCode("PFS 7F3K2Q9X")).toBe("PFS-7F3K2Q9X");
    // Body only (prefix dropped on the fax) still resolves.
    expect(normalizeTrackingCode("7f3k2q9x")).toBe("PFS-7F3K2Q9X");
  });
});

describe("registerSignatureTracking", () => {
  it("reuses the existing code for a document already tracked", async () => {
    stageSupabaseResponse("signature_tracking", "select", {
      data: { id: "t1", tracking_code: "PFS-ABCD2345" },
    });
    const supabase = getSupabaseServiceRoleClient();
    const result = await registerSignatureTracking(supabase, {
      kind: "prescription_request",
      documentId: "doc-1",
      title: "Prescription request",
    });
    expect(result).toEqual({
      trackingCode: "PFS-ABCD2345",
      id: "t1",
      created: false,
    });
    // It refreshed the snapshot (an update), not a fresh insert.
    expect(supabaseMock.callCount("signature_tracking", "update")).toBe(1);
    expect(supabaseMock.callCount("signature_tracking", "insert")).toBe(0);
  });

  it("inserts a new row with a freshly minted code", async () => {
    stageSupabaseResponse("signature_tracking", "select", { data: null });
    stageSupabaseResponse("signature_tracking", "insert", {
      data: { id: "t2" },
    });
    const supabase = getSupabaseServiceRoleClient();
    const result = await registerSignatureTracking(supabase, {
      kind: "manual_document",
      documentId: "doc-2",
      title: "Agreement",
    });
    expect(result.created).toBe(true);
    expect(result.id).toBe("t2");
    expect(result.trackingCode).toMatch(/^PFS-[A-Z2-9]{8}$/);
  });
});

describe("listOutstandingSignatures", () => {
  it("groups outstanding items by provider, most-overdue first", async () => {
    stageSupabaseResponse("signature_tracking", "select", {
      data: [
        row({
          id: "r1",
          provider_id: "p1",
          provider_label: "Dr. A",
          created_at: "2026-01-01T00:00:00Z",
        }),
        row({
          id: "r2",
          provider_id: "p1",
          provider_label: "Dr. A",
          created_at: "2026-02-01T00:00:00Z",
        }),
        row({
          id: "r3",
          provider_id: "p2",
          provider_label: "Dr. B",
          created_at: "2026-03-01T00:00:00Z",
        }),
        row({
          id: "r4",
          provider_id: null,
          provider_label: null,
          created_at: "2026-04-01T00:00:00Z",
        }),
      ],
    });
    const supabase = getSupabaseServiceRoleClient();
    const result = await listOutstandingSignatures(supabase);

    expect(result.count).toBe(4);
    expect(result.byProvider.map((g) => [g.label, g.count])).toEqual([
      ["Dr. A", 2],
      ["Dr. B", 1],
      ["Unassigned / no provider", 1],
    ]);
    expect(result.byProvider[0]!.oldestCreatedAt).toBe("2026-01-01T00:00:00Z");
  });
});

function row(overrides: Record<string, unknown>) {
  return {
    id: "r",
    tracking_code: "PFS-AAAA2345",
    document_kind: "prescription_request",
    document_id: "doc",
    patient_id: null,
    provider_id: null,
    patient_label: null,
    provider_label: null,
    practice_name: null,
    title: "Prescription request",
    status: "awaiting_signature",
    delivery_channel: "fax",
    return_fax_e164: null,
    sent_count: 1,
    last_sent_at: null,
    returned_at: null,
    canceled_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
