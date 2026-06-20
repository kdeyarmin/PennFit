import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { SEND_VOICE_JOB } from "./reminder-voice";

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "reminder-voice.ts"),
  "utf8",
);

describe("reminders.place-call — job identity", () => {
  it("uses the stable queue name the escalation scan enqueues to", () => {
    expect(SEND_VOICE_JOB).toBe("reminders.place-call");
  });
});

// Source guards: the voice send job MUST reuse the shared safety machinery
// rather than re-implement it, and MUST degrade gracefully. A behavioural
// test would need to mock pg-boss + a paged Supabase client + the voice
// config; pin the invariants cheaply via source, like the escalation tests.
describe("reminders.place-call — wiring invariants", () => {
  it("dials through the shared placeOutboundReorderCall helper", () => {
    expect(SRC).toContain("placeOutboundReorderCall(");
  });

  it("claims a per-day dedup key on the 'voice' channel", () => {
    expect(SRC).toContain("tryClaimReminderDedupKey(");
    expect(SRC).toContain('"voice"');
  });

  it("gates on local business hours before dialing (TCPA)", () => {
    expect(SRC).toContain("isWithinQuietHours(");
  });

  it("skips (log + exit 0) when the voice path is unconfigured", () => {
    expect(SRC).toContain("readVoiceConfigOrNull(");
    expect(SRC).toContain("config.twilioPhoneNumber");
  });

  it("releases the dedup claim on a retryable failure so pg-boss can retry", () => {
    expect(SRC).toContain("releaseReminderDedupKey(");
    expect(SRC).toContain("twilio_api_error");
  });

  it("meters a successful call as an aiVoiceEvents usage event", () => {
    expect(SRC).toContain('metricKey: "aiVoiceEvents"');
  });
});
