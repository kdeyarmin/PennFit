import { describe, it, expect } from "vitest";
import { buildChatSystemPrompt } from "./chatbotKnowledge";
import { buildCustomerChatSystemPrompt } from "./customerChatKnowledge";

/**
 * Guard tests for the two chatbot system-prompt builders. They build a
 * large static prompt out of many knowledge sections; the builders throw
 * if the assembled prompt exceeds their char cap. These tests assert the
 * prompt builds (so an over-cap edit fails CI rather than at runtime) and
 * that the newer research-backed knowledge sections stay wired in.
 */
describe("buildChatSystemPrompt (public PennBot)", () => {
  const prompt = buildChatSystemPrompt();

  it("builds under the char cap without throwing", () => {
    expect(prompt.length).toBeGreaterThan(0);
    // Comfortable headroom below the 110k tripwire so routine edits don't
    // trip it, while still catching a runaway section.
    expect(prompt.length).toBeLessThan(110_000);
  });

  it("includes the CPAP-alternatives knowledge (oral appliances, Inspire, Zepbound)", () => {
    expect(prompt).toContain("Alternatives and add-ons to CPAP therapy");
    expect(prompt).toMatch(/mandibular advancement/i);
    expect(prompt).toMatch(/hypoglossal nerve stimulation/i);
    expect(prompt).toMatch(/tirzepatide|Zepbound/);
  });

  it("includes the untreated-OSA health-risk section", () => {
    expect(prompt).toContain("Why treating sleep apnea matters");
    expect(prompt).toMatch(/atrial fibrillation/i);
  });

  it("includes the cushion-materials / comfort-accessories section", () => {
    expect(prompt).toContain("Cushion materials and comfort accessories");
    expect(prompt).toMatch(/memory foam/i);
    expect(prompt).toMatch(/mask liners/i);
  });

  it("carries the updated Philips recall settlement / consent-decree facts", () => {
    expect(prompt).toMatch(/consent decree/i);
    expect(prompt).toMatch(/\$1\.1 billion/);
  });

  it("includes the first-30-nights new-user coaching section", () => {
    expect(prompt).toContain("The first 30 nights");
    expect(prompt).toMatch(/REM rebound/i);
  });

  it("includes the plain-English insurance glossary", () => {
    expect(prompt).toContain("Insurance words, translated into plain English");
    expect(prompt).toMatch(/Coinsurance/);
    expect(prompt).toMatch(/Capped rental/);
  });

  it("includes the caregivers / family section", () => {
    expect(prompt).toContain("caregivers and family");
    expect(prompt).toMatch(/reluctant partner/i);
  });

  it("includes the voice/personality section with example exchanges", () => {
    expect(prompt).toContain("PennBot's voice and personality");
    expect(prompt).toContain("Empathy playbook");
    expect(prompt).toContain("Honesty about being an AI");
    expect(prompt).toContain("Example exchanges");
  });
});

describe("buildCustomerChatSystemPrompt (signed-in PennBot)", () => {
  const prompt = buildCustomerChatSystemPrompt({
    displayName: null,
    memberSince: null,
    totalPaidOrders: 0,
    latestOrder: null,
    activeSubscriptionCount: 0,
    device: null,
  });

  it("builds under the char cap without throwing", () => {
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt.length).toBeLessThan(40_000);
  });

  it("includes the softer-cushion guidance for face marks / irritation", () => {
    expect(prompt).toMatch(/memory-foam|AirTouch/);
  });

  it("includes the human-voice guidance and AI-honesty rule", () => {
    expect(prompt).toContain("this is what makes you feel human");
    expect(prompt).toMatch(/virtual assistant/);
    expect(prompt).toContain("Example exchanges");
  });
});
