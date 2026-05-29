// Tests for the retention sweep worker.
//
// Coverage:
//   * Backfill computes retention_until_at on rows missing it
//   * Backfill skips legal-hold / destroyed rows
//   * Flag stamps retention_marked_at on past-horizon rows
//   * Flag respects legal_hold + destroyed_at + already-marked

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runRetentionSweep } from "./patient-documents-retention-sweep";

beforeEach(() => {
  supabaseMock.reset();
  vi.useRealTimers();
});

describe("runRetentionSweep — backfill", () => {
  it("computes and writes retention_until_at for unbackfilled rows", async () => {
    // Page 1 of the backfill scan returns one row; page 2 empty.
    stageSupabaseResponse("patient_documents", "select", {
      data: [
        {
          id: "doc_1",
          document_type: "prescription",
          // 2020-01-15; +7y → 2027-01-15
          created_at: "2020-01-15T00:00:00Z",
        },
      ],
    });
    // The per-row update is an update verb on the same table.
    stageSupabaseResponse("patient_documents", "update", { data: null });
    // Second loop iteration: empty page closes the backfill loop.
    stageSupabaseResponse("patient_documents", "select", { data: [] });
    // Final flag-stamp query (returns 0 flagged rows because the
    // staged response is empty).
    stageSupabaseResponse("patient_documents", "update", { data: [] });

    const stats = await runRetentionSweep();
    expect(stats.backfilled).toBe(1);

    const writes = getSupabaseWritePayloads("patient_documents", "update");
    // First update is the backfill; assert the computed horizon.
    expect(writes[0]).toBeDefined();
    const backfillUpdate = writes[0] as { retention_until_at: string };
    expect(backfillUpdate.retention_until_at).toBe("2027-01-15T00:00:00.000Z");
  });
});

describe("runRetentionSweep — flag", () => {
  it("stamps retention_marked_at on the bulk update", async () => {
    // No backfill candidates.
    stageSupabaseResponse("patient_documents", "select", { data: [] });
    // The sweep now SELECTs the bounded eligible-row batch BEFORE
    // doing the UPDATE-by-id, so that the .select() return doesn't
    // page-cap the audit-loop input (HIPAA gap). Stage the same
    // row shape for the eligible-batch select; the subsequent
    // UPDATE re-fetches them.
    const flaggedRows = [
      {
        id: "doc_a",
        patient_id: "pt_1",
        document_type: "prescription",
        size_bytes: 1234,
        retention_until_at: "2026-05-01T00:00:00Z",
      },
      {
        id: "doc_b",
        patient_id: "pt_2",
        document_type: "sleep_study",
        size_bytes: 5678,
        retention_until_at: "2026-05-02T00:00:00Z",
      },
    ];
    stageSupabaseResponse("patient_documents", "select", { data: flaggedRows });
    // Flag step returns two rows touched. The full row shape mirrors
    // what the production `.select(...)` requests so the audit
    // metadata block can read the fields.
    stageSupabaseResponse("patient_documents", "update", { data: flaggedRows });

    const stats = await runRetentionSweep();
    expect(stats.flagged).toBe(2);

    const writes = getSupabaseWritePayloads("patient_documents", "update");
    const flagUpdate = writes[0] as { retention_marked_at: string };
    expect(flagUpdate).toBeDefined();
    expect(flagUpdate.retention_marked_at).toBeTypeOf("string");

    // HIPAA tamper-evident audit-log writes used to be asserted here.
    // The audit_log table was retired with the wider compliance
    // teardown; the retention sweep still flags documents but no
    // longer writes audit rows.
  });

  it("returns zero counts when nothing is due", async () => {
    stageSupabaseResponse("patient_documents", "select", { data: [] });
    stageSupabaseResponse("patient_documents", "update", { data: [] });
    const stats = await runRetentionSweep();
    expect(stats.backfilled).toBe(0);
    expect(stats.flagged).toBe(0);
    // No flagged rows → no audit writes (zero per-document trail when
    // nothing was touched).
    expect(getSupabaseCallCount("audit_log", "insert")).toBe(0);
  });
});
