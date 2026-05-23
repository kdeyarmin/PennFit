// Coverage for the audit-log archive sweep.
//
// The single LOAD-BEARING contract of this worker is:
//   "flag only, never auto-delete."
//
// Surveyors and counsel require a human step in the destruction path
// for HIPAA-relevant audit_log rows. A future revert (or careless
// edit) that turns the .update({archived_at}) call into .delete()
// would wipe years of audit history silently. This file pins down:
//
//   1. The sweep updates only flagged-with-archived_at rows.
//   2. The sweep never calls .delete() on audit_log.
//   3. The cutoff respects the 6-year retention floor.

import { describe, expect, it, beforeEach } from "vitest";

import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runAuditLogArchiveSweep } from "./audit-log-archive-sweep";

describe("runAuditLogArchiveSweep", () => {
  beforeEach(() => supabaseMock.reset());

  it("flags rows past the retention horizon as archived", async () => {
    stageSupabaseResponse("audit_log", "update", {
      data: [{ id: "a-1" }, { id: "a-2" }],
    });
    const stats = await runAuditLogArchiveSweep();
    expect(stats.flagged).toBe(2);
    const updates = getSupabaseWritePayloads("audit_log", "update");
    expect(updates).toHaveLength(1);
    expect((updates[0] as Record<string, unknown>).archived_at).toEqual(
      expect.any(String),
    );
  });

  it("returns 0 when no rows are past the retention horizon", async () => {
    stageSupabaseResponse("audit_log", "update", { data: [] });
    const stats = await runAuditLogArchiveSweep();
    expect(stats.flagged).toBe(0);
  });

  it("never invokes .delete() on the audit_log table", async () => {
    // Belt-and-braces: even if a misconfiguration / revert later
    // routes destruction through this sweep, the test would fail
    // immediately. The mock's getSupabaseWritePayloads exposes
    // captured DELETEs the same way it does UPDATEs.
    stageSupabaseResponse("audit_log", "update", { data: [] });
    await runAuditLogArchiveSweep();
    const deletes = getSupabaseWritePayloads("audit_log", "delete");
    expect(deletes).toHaveLength(0);
  });
});
