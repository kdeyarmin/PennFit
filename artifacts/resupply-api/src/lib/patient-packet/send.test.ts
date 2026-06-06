import { describe, it, expect } from "vitest";

import { createAndSendPatientPacket, deliverPacketLink } from "./send";

describe("createAndSendPatientPacket", () => {
  it("rejects invalid document keys before touching the database", async () => {
    // Invalid keys are validated up front, so no Supabase client is
    // needed — passing an object that would throw if used proves it.
    const res = await createAndSendPatientPacket({
      supabase: {} as never,
      patientId: "11111111-1111-1111-1111-111111111111",
      documentKeys: ["assignment_of_benefits", "not_a_real_doc"],
    });
    expect(res).toEqual({
      ok: false,
      code: "invalid_document_keys",
      invalidKeys: ["not_a_real_doc"],
    });
  });
});

describe("deliverPacketLink", () => {
  it("is a no-op when no channel has a recipient (no vendor calls)", async () => {
    const res = await deliverPacketLink({
      supabase: {} as never,
      recipientName: "Pat",
      link: "https://example.com/patient-packet-sign?token=abc.def",
      email: null,
      phone: null,
      channels: ["email", "sms"],
    });
    expect(res).toEqual({ emailSent: false, smsSent: false });
  });

  it("skips a channel that isn't requested even if a recipient exists", async () => {
    // SMS requested but only an email on file → nothing to send, returns
    // before resolving the company profile (so the dummy client is safe).
    const res = await deliverPacketLink({
      supabase: {} as never,
      recipientName: "Pat",
      link: "https://example.com/patient-packet-sign?token=abc.def",
      email: "pat@example.com",
      phone: null,
      channels: ["sms"],
    });
    expect(res).toEqual({ emailSent: false, smsSent: false });
  });
});
