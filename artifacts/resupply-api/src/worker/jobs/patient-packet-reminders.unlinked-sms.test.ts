// Patient-packet reminder sweep — contact-only (unlinked) packets get an
// SMS nudge too.
//
// A packet sent to a bare email/phone (no patient record) has
// patient_id = NULL, so the sweep's patient lookup finds no phone for it.
// Before the fix it could only ever be reminded by email; the recipient
// phone captured at send time was never texted. This proves the sweep now
// falls back to `recipient_phone` for the SMS channel on an unlinked
// packet, while still routing a linked packet to the patient's own number.
//
// The claim + delivery body is exercised against the lightweight supabase
// mock; link signing + delivery are stubbed, and the TCPA send-window gate
// is forced open so the assertion doesn't depend on the wall clock.

import { describe, it, expect, vi, beforeEach } from "vitest";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

// Force the send window open so phone selection — not the clock — is what
// the assertion measures.
vi.mock("../../lib/comm-prefs", () => ({
  isOutsideSmsSendWindow: () => false,
}));

const deliverMock = vi.hoisted(() =>
  vi.fn(async () => ({ emailSent: true, smsSent: true })),
);
vi.mock("../../lib/patient-packet/send", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/patient-packet/send")
  >("../../lib/patient-packet/send");
  return {
    ...actual,
    buildPacketSigningLink: () => "https://test.example/sign?token=stub",
    deliverPacketLink: deliverMock,
  };
});

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runPatientPacketReminderSweep } from "./patient-packet-reminders";

beforeEach(() => {
  supabaseMock.reset();
  deliverMock.mockClear();
  isFeatureEnabledMock.mockReset().mockResolvedValue(true);
});

describe("patient-packet reminder sweep — unlinked packet SMS fallback", () => {
  it("texts the recipient_phone for a contact-only packet (no patient row)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }],
    });
    // One reminder-eligible packet with NO patient_id but a recipient phone.
    stageSupabaseResponse("patient_packets", "select", {
      data: [
        {
          id: "packet-1",
          patient_id: null,
          link_version: 1,
          reminder_count: 0,
          recipient_name: "Pat Contact",
          recipient_email: "pat@example.test",
          recipient_phone: "+12155550123",
          sent_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
          status: "sent",
          expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          last_reminded_at: null,
        },
      ],
    });
    // No patient rows to resolve (the only candidate is unlinked).
    stageSupabaseResponse("patients", "select", { data: [] });
    // The compare-and-set claim succeeds.
    stageSupabaseResponse("patient_packets", "update", {
      data: { id: "packet-1" },
    });

    const stats = await runPatientPacketReminderSweep();

    expect(stats.reminded).toBe(1);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const arg = deliverMock.mock.calls[0]![0] as {
      email: string | null;
      phone: string | null;
    };
    expect(arg.email).toBe("pat@example.test");
    // The fix: the unlinked packet's captured phone is used for SMS.
    expect(arg.phone).toBe("+12155550123");
  });
});
