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
});
