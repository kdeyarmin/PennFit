// Recall-notification send sweep: multi-tenant fan-out smoke coverage.
//
// The per-send channel logic is covered in recall-notifications-send.test.ts,
// and the full claim-and-send body runs against a real PostgREST surface in
// the integration suite (recall-notifications-send.integration.test.ts).
// Here we verify the sweep fans out across active tenants and no-ops cleanly
// when there are none.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runRecallSendSweep } from "./recall-notifications-send";

beforeEach(() => supabaseMock.reset());

describe("runRecallSendSweep — multi-tenant fan-out", () => {
  it("runs once per active tenant (empty queues → zero sends)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const stats = await runRecallSendSweep();
    expect(stats.sent).toBe(0);
    expect(stats.attempted).toBe(0);
    // Each active tenant read its own queued-notification queue.
    expect(getSupabaseCallCount("recall_notifications", "select")).toBe(2);
  });

  it("no-ops when there are no active tenants (no queue read)", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runRecallSendSweep();
    expect(stats).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0 });
    expect(getSupabaseCallCount("recall_notifications", "select")).toBe(0);
  });
});
