// Patient-packet reminder sweep: per-tenant flag gate + multi-tenant
// fan-out. The full claim-and-send body runs against a real PostgREST
// surface in the integration suite
// (patient-packet-reminders.integration.test.ts); here we cover the
// control flow: the autoremind flag is evaluated PER TENANT (with the
// org_id), the sweep walks every active tenant, and it reports `skipped`
// only when NO active tenant has the flag on.

import { describe, it, expect, vi, beforeEach } from "vitest";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runPatientPacketReminderSweep } from "./patient-packet-reminders";

beforeEach(() => {
  supabaseMock.reset();
  isFeatureEnabledMock.mockReset().mockResolvedValue(true);
});

describe("patient-packet reminder sweep — per-tenant flag gate + fan-out", () => {
  it("reports skipped (no DB read) when no tenant has the autoremind flag on", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    isFeatureEnabledMock.mockResolvedValue(false);
    const stats = await runPatientPacketReminderSweep();
    expect(stats.skipped).toBe(true);
    expect(stats.reminded).toBe(0);
    // Flag is checked PER TENANT with the org_id.
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "patient_packets.autoremind",
      "org-a",
    );
    // Flag off → no packet queue read for any tenant.
    expect(getSupabaseCallCount("patient_packets", "select")).toBe(0);
  });

  it("fans out across enabled tenants (empty queues → zero reminders)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const stats = await runPatientPacketReminderSweep();
    expect(stats.skipped).toBeFalsy();
    expect(stats.scanned).toBe(0);
    expect(stats.reminded).toBe(0);
    // Each enabled tenant read its own packet queue.
    expect(getSupabaseCallCount("patient_packets", "select")).toBe(2);
  });

  it("reports skipped when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runPatientPacketReminderSweep();
    expect(stats.skipped).toBe(true);
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
  });
});
