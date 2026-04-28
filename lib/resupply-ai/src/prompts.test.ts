import { describe, expect, it } from "vitest";
import { buildSystemPrompt, DEFAULT_GREETING, PROMPT_VERSION } from "./prompts";

// We pin the assertions on substring presence rather than full
// snapshot match: bumping the prompt to fix a clinical-safety nit
// shouldn't fail the build, but DROPPING any of the load-bearing
// safety clauses absolutely should.
//
// Each assertion below is a clause we'd want to be reminded about
// before an edit removes it — read the prompts.ts file header for
// the rationale on each one.

describe("buildSystemPrompt", () => {
  const baseInput = {
    practiceName: "Penn Home Medical",
    callContext: "Outbound resupply outreach for a 90-day refill cycle.",
  };

  it("includes the practice name and the canonical greeting verbatim", () => {
    const prompt = buildSystemPrompt(baseInput);
    expect(prompt).toContain("Penn Home Medical");
    expect(prompt).toContain(DEFAULT_GREETING);
  });

  it("includes the prompt version so audit logs can pin behaviour", () => {
    const prompt = buildSystemPrompt(baseInput);
    expect(prompt).toContain(PROMPT_VERSION);
  });

  it("uses the override callerName when supplied", () => {
    const prompt = buildSystemPrompt({ ...baseInput, callerName: "Avery" });
    expect(prompt).toContain("Avery");
  });

  it("falls back to a generic agent self-description when callerName is omitted", () => {
    const prompt = buildSystemPrompt(baseInput);
    expect(prompt).toContain("CPAP resupply assistant");
  });

  it("requires identity verification before any other tool", () => {
    const prompt = buildSystemPrompt(baseInput);
    expect(prompt).toMatch(/verify_patient_identity/);
    expect(prompt).toMatch(/MUST be called and succeed|MUST call|MUST be called|first/i);
  });

  it("enumerates the load-bearing safety clauses (PHI privacy + medical-advice + handoff + hangup)", () => {
    const prompt = buildSystemPrompt(baseInput);
    // PHI privacy
    expect(prompt).toMatch(/never read.*verbatim|never read the patient's full/i);
    // No medical advice
    expect(prompt).toMatch(/medical advice/i);
    // Hand-off triggers
    expect(prompt).toMatch(/request_human_handoff/);
    expect(prompt).toMatch(/distress|self-harm|suicide/i);
    // Hangup discipline
    expect(prompt).toMatch(/end_call/);
  });

  it("rejects empty practice name (zod validation)", () => {
    expect(() =>
      buildSystemPrompt({ ...baseInput, practiceName: "   " }),
    ).toThrow(/practiceName/);
  });

  it("rejects empty callContext (zod validation)", () => {
    expect(() => buildSystemPrompt({ ...baseInput, callContext: "" })).toThrow();
  });
});
