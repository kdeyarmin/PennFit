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

  it("uses the override greeting when supplied (inbound reorder IVR)", () => {
    const inboundGreeting =
      "Hi there, thanks for calling your CPAP resupply line!";
    const prompt = buildSystemPrompt({
      ...baseInput,
      greeting: inboundGreeting,
    });
    expect(prompt).toContain(inboundGreeting);
    // The outbound default greeting must NOT also appear.
    expect(prompt).not.toContain(DEFAULT_GREETING);
  });

  it("falls back to a generic agent self-description when callerName is omitted", () => {
    const prompt = buildSystemPrompt(baseInput);
    expect(prompt).toContain("CPAP resupply assistant");
  });

  it("requires identity verification before any other tool", () => {
    const prompt = buildSystemPrompt(baseInput);
    expect(prompt).toMatch(/verify_patient_identity/);
    expect(prompt).toMatch(
      /MUST be called and succeed|MUST call|MUST be called|first/i,
    );
  });

  it("enumerates the load-bearing safety clauses (PHI privacy + medical-advice + handoff + hangup)", () => {
    const prompt = buildSystemPrompt(baseInput);
    // PHI privacy
    expect(prompt).toMatch(
      /never read.*verbatim|never read the patient's full/i,
    );
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
    expect(() =>
      buildSystemPrompt({ ...baseInput, callContext: "" }),
    ).toThrow();
  });
});

describe("buildSystemPrompt — breathe_prospect (B2B platform sales)", () => {
  const salesInput = {
    practiceName: "CareMetric Breathe",
    callContext: "Inbound platform sales call.",
    callerKind: "breathe_prospect" as const,
  };

  it("is platform-branded as CareMetric Breathe (not tenant-branded)", () => {
    const prompt = buildSystemPrompt(salesInput);
    expect(prompt).toContain("CareMetric Breathe");
    // It must not present itself as a patient resupply assistant.
    expect(prompt).not.toContain("CPAP resupply assistant");
  });

  it("routes the three call-reason skills via identify_call_reason", () => {
    const prompt = buildSystemPrompt(salesInput);
    expect(prompt).toContain("identify_call_reason");
    expect(prompt).toMatch(/SALES/);
    expect(prompt).toMatch(/CUSTOMER SERVICE/);
    expect(prompt).toMatch(/TECH SUPPORT/);
  });

  it("quotes the subscription tiers and the per-active-patient meter", () => {
    const prompt = buildSystemPrompt(salesInput);
    expect(prompt).toContain("Launch");
    expect(prompt).toContain("Growth");
    expect(prompt).toContain("Scale");
    expect(prompt).toContain("Enterprise");
    expect(prompt).toContain("$499");
    expect(prompt).toContain("$1.25");
    expect(prompt).toContain("$2,500");
  });

  it("forbids collecting a spoken password and exposes the sales tools", () => {
    const prompt = buildSystemPrompt(salesInput);
    expect(prompt).toMatch(/NEVER ask for, accept, or repeat a password/i);
    expect(prompt).toContain("send_info_email");
    expect(prompt).toContain("capture_sales_lead");
    expect(prompt).toContain("start_breathe_signup");
  });

  it("requires a chosen plan before creating an account, and routes Enterprise to a human", () => {
    const prompt = buildSystemPrompt(salesInput);
    // The agent must not provision an account before a plan is selected.
    expect(prompt).toMatch(
      /NEVER create an account before the caller has chosen a specific plan/i,
    );
    // Enterprise is custom-quoted — never a phone self-signup.
    expect(prompt).toMatch(/never sign anyone up for Enterprise/i);
  });

  it("carries no patient PHI clauses (no DOB verification, no medical-advice scope)", () => {
    const prompt = buildSystemPrompt(salesInput);
    expect(prompt).not.toContain("verify_patient_identity");
    expect(prompt).not.toContain("date of birth");
  });
});
