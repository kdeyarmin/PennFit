// The reminder sweep is gated by the patient_packets.autoremind flag.
// When the flag is off it must short-circuit before doing any DB work.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

// Guard: if the gate were bypassed, this would throw when the sweep
// tried to query Supabase.
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => {
    throw new Error("DB should not be touched when the flag is off");
  },
}));

import { runPatientPacketReminderSweep } from "./patient-packet-reminders";

describe("patient-packet reminder sweep", () => {
  it("is a no-op when the autoremind flag is disabled", async () => {
    const stats = await runPatientPacketReminderSweep();
    expect(stats).toEqual({
      skipped: true,
      scanned: 0,
      reminded: 0,
      emailSent: 0,
      smsSent: 0,
    });
  });
});
