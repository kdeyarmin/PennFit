// Tests for the AI reply drafter (CSR #15) — the pure transcript /
// prompt builders + the soft provider-selection branches. The Anthropic
// happy path makes a network call and is not exercised here (matches
// ai-classify.test.ts: we test the pure surface, not the vendor call).

import { describe, it, expect } from "vitest";

import {
  buildRedactedTranscript,
  buildDraftPrompt,
  draftConversationReply,
  MAX_TURNS,
  type DraftTurn,
} from "./draft-reply";

function turn(over: Partial<DraftTurn>): DraftTurn {
  return {
    direction: "inbound",
    sender_role: "patient",
    body: "Hello",
    ...over,
  };
}

describe("buildRedactedTranscript", () => {
  it("labels speakers and scrubs PII, oldest→newest", () => {
    const { transcript, redactions } = buildRedactedTranscript([
      turn({ direction: "inbound", body: "Call me at 215-555-1212" }),
      turn({ direction: "outbound", body: "Sure, what's your email?" }),
      turn({ direction: "inbound", body: "it's jane@example.com" }),
    ]);
    expect(transcript.split("\n")).toEqual([
      "Patient: Call me at [redacted-phone]",
      "Agent: Sure, what's your email?",
      "Patient: it's [redacted-email]",
    ]);
    expect(redactions).toBe(2);
  });

  it("skips blank bodies and keeps only the most recent MAX_TURNS", () => {
    const many: DraftTurn[] = [];
    for (let i = 0; i < MAX_TURNS + 5; i++) {
      many.push(turn({ body: `msg ${i}` }));
    }
    many.push(turn({ body: "   " })); // blank — skipped
    const { transcript } = buildRedactedTranscript(many);
    const lines = transcript.split("\n");
    expect(lines.length).toBe(MAX_TURNS);
    // The oldest 5 (msg 0..4) fall out of the window; msg 5 is first kept.
    expect(lines[0]).toContain("msg 5");
  });
});

describe("buildDraftPrompt", () => {
  it("includes the channel, the transcript, and the patient first name", () => {
    const { user, system, redactions } = buildDraftPrompt({
      channel: "sms",
      patientFirstName: "Jane",
      turns: [turn({ body: "Where's my order?" })],
    });
    expect(system).toContain("customer-service agent");
    expect(user).toContain("Channel: sms");
    expect(user).toContain("Patient first name: Jane");
    expect(user).toContain("Where's my order?");
    expect(redactions).toBe(0);
  });

  it("omits the name line when no first name is given", () => {
    const { user } = buildDraftPrompt({
      channel: "email",
      turns: [turn({ body: "Hi" })],
    });
    expect(user).not.toContain("Patient first name:");
  });
});

describe("draftConversationReply (soft branches)", () => {
  it("returns offline when no LLM key is configured", async () => {
    const result = await draftConversationReply({
      channel: "sms",
      turns: [turn({ body: "Call me at 215-555-1212" })],
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toEqual({ ok: false, reason: "offline", redactions: 1 });
  });

  it("reports provider_unsupported when only OpenAI is configured", async () => {
    const result = await draftConversationReply({
      channel: "sms",
      turns: [turn({ body: "hello" })],
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provider_unsupported");
  });
});
