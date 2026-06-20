// Unit tests for the per-step default reminder SMS bodies. The full send
// flow is covered by send-sms.test.ts; these pin the copy + the GSM-7
// single-segment invariant for each escalation variant.

import { describe, it, expect } from "vitest";

import { defaultReminderSmsBody, smsAsksRefillAttestation } from "./send-sms";

const NAME = "Sam";
const PRACTICE = "PennPaps";

// GSM-7 has no em-dash, curly quotes, or ellipsis; any of those silently
// flips Twilio to UCS-2 (70-char segments), tripling cost at scale.
const UCS2_TRIGGERS = /[—–“”‘’…]/;

describe("defaultReminderSmsBody", () => {
  const variants = ["initial", "followup", "final"] as const;

  it("renders a distinct body per variant", () => {
    const bodies = variants.map((v) =>
      defaultReminderSmsBody(v, NAME, PRACTICE),
    );
    expect(new Set(bodies).size).toBe(variants.length);
  });

  it("pins the 'initial' copy and its refill attestation framing", () => {
    // The YES reply is the patient's Medicare/payer refill attestation, so
    // the copy asks them to confirm continued use AND running low before
    // replying (see REFILL_AFFIRMATION_STATEMENT).
    expect(defaultReminderSmsBody("initial", NAME, PRACTICE)).toBe(
      "Hi Sam, it's PennPaps. Time for a CPAP refill. Reply YES if you still use it and are low on supplies, EDIT to change address, STOP to opt out.",
    );
  });

  for (const v of variants) {
    it(`'${v}' is personalized, actionable, opt-out-able, and GSM-7 single-segment`, () => {
      const body = defaultReminderSmsBody(v, NAME, PRACTICE);
      expect(body).toContain(NAME);
      expect(body).toContain(PRACTICE);
      expect(body).toContain("YES");
      expect(body).toContain("STOP");
      // No UCS-2-triggering characters.
      expect(body).not.toMatch(UCS2_TRIGGERS);
      // One GSM-7 segment is 160 chars; stay within it for a typical name.
      expect(body.length).toBeLessThanOrEqual(160);
    });
  }

  it("every default variant is detected as attestation-bearing", () => {
    for (const v of variants) {
      expect(
        smsAsksRefillAttestation(defaultReminderSmsBody(v, NAME, PRACTICE)),
      ).toBe(true);
    }
  });

  it("does not flag custom/legacy bodies that omit the attestation ask", () => {
    expect(
      smsAsksRefillAttestation(
        "You're due for a CPAP refill. Reply YES to ship, STOP to opt out.",
      ),
    ).toBe(false);
  });

  it("escalates urgency: followup circles back, final is a last call", () => {
    expect(defaultReminderSmsBody("followup", NAME, PRACTICE)).toContain(
      "checking back",
    );
    expect(defaultReminderSmsBody("final", NAME, PRACTICE)).toContain(
      "Last reminder",
    );
  });
});
