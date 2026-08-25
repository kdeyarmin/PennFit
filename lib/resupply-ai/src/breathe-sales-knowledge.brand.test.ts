// Guards the CareMetric Breathe B2B sales agent's brand.
//
// This is the one AI surface with NO normalization layer. Every other
// prompt in the app leaves the process through
// `applyPlatformBranding()` / `applyCompanyIdentityToText()`
// (artifacts/resupply-api/src/lib/company-info.ts), which is why the big
// knowledge bases can keep "PennFit" / "PennBot" / "Penn Home Medical
// Supply" as in-source placeholders. This prompt does not: it is composed
// synchronously inside the RealtimeClient constructor in a pure package
// that must not depend on the data layer, so whatever is written here is
// what the agent SAYS OUT LOUD.
//
// And it says it to a prospective DME business — a stranger evaluating the
// product. "PennFit" is the repository codename, not a product; "Penn Home
// Medical Supply" is one customer. Either one, spoken on a sales call, is
// wrong in a way no downstream layer will catch.
//
// So: assert directly on the rendered prompt. If you need to name the
// product here, it is CareMetric Breathe.

import { describe, expect, it } from "vitest";

import { BREATHE_SALES_KNOWLEDGE } from "./breathe-sales-knowledge";
import { buildSystemPrompt } from "./prompts";

/**
 * Brand tokens that must never reach a platform prospect. Matched
 * case-insensitively, and again with every separator stripped, so
 * "penn-home-medical" and "PennHomeMedical" are caught alongside the
 * spaced spelling.
 */
const TENANT_AND_CODENAME_TOKENS = [
  "pennfit",
  "pennpaps",
  "penn home medical",
  "penn paps",
  "pennbot",
  "pennpilot",
];

function offendingTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return TENANT_AND_CODENAME_TOKENS.filter(
    (t) => lower.includes(t) || compact.includes(t.replace(/[^a-z0-9]/g, "")),
  );
}

describe("CareMetric Breathe sales knowledge", () => {
  it("names the platform and no tenant or repo codename", () => {
    expect(
      offendingTokens(BREATHE_SALES_KNOWLEDGE),
      "The B2B sales agent speaks this verbatim to prospects and nothing " +
        "rewrites it downstream. The product is CareMetric Breathe.",
    ).toEqual([]);
    expect(BREATHE_SALES_KNOWLEDGE).toContain("CareMetric Breathe");
  });

  it("renders a breathe_prospect prompt carrying no tenant brand", () => {
    // The full render, not just the knowledge block — the persona,
    // guardrails, playbook and tool copy are equally unnormalized.
    const prompt = buildSystemPrompt({
      practiceName: "CareMetric Breathe",
      callerKind: "breathe_prospect",
      callContext: "Inbound platform sales call from a prospective DME.",
    });
    expect(offendingTokens(prompt)).toEqual([]);
    expect(prompt).toContain("CareMetric Breathe");
  });
});
