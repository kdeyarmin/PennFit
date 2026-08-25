// Guards the admin-console knowledge base against tenant-brand leaks.
//
// This prompt is shared by two surfaces with DIFFERENT normalization:
//
//   * the in-app admin assistant (routes/admin/assistant-chat.ts) runs it
//     through `applyPlatformBrandingForOrg`, which resolves the PLATFORM
//     tokens — PennFit → CareMetric Breathe, PennPilot → the tenant's own
//     admin-assistant name — but NOT `applyCompanyIdentityToText`; and
//   * the platform support desk (lib/support-bot) runs both, against the
//     platform identity.
//
// So the Penn* PLATFORM placeholders are fine here — every consumer resolves
// them — but a TENANT identity is not. "Penn Home Medical Supply" and
// "pennpaps.com" belong to one customer, and on the assistant path nothing
// rewrites them, so they would describe every other tenant's console as that
// customer's. The knowledge base is about the PRODUCT; it must describe the
// operator's practice generically ("your practice") and let the name come
// from the operator.
//
// This is the same rule the demo sandbox enforces in
// artifacts/cpap-fitter/src/demo/brand.test.ts, applied to the other shared
// surface that ships tenant-visible prose.

import { describe, expect, it } from "vitest";

import {
  ADMIN_OFFLINE_FALLBACK_REPLY,
  buildAdminAssistantSystemPrompt,
} from "./adminAssistantKnowledge";

/**
 * Tenant-identity tokens. Matched case-insensitively and again with every
 * separator stripped, so "penn-home-medical" and "PennHomeMedical" are caught
 * alongside the spaced spelling.
 *
 * Deliberately NOT listed: "PennFit", "PennBot", "PennPilot". Those are the
 * platform/assistant placeholders `applyPlatformBranding()` resolves at the
 * I/O boundary — keeping them in source is what spares these large knowledge
 * bases a rewrite.
 */
const TENANT_TOKENS = ["pennpaps", "penn home medical", "penn paps"];

function offendingTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return TENANT_TOKENS.filter(
    (t) => lower.includes(t) || compact.includes(t.replace(/[^a-z0-9]/g, "")),
  );
}

const CTX = { adminEmail: "owner@acme.test", adminRole: "admin" as const };

describe("admin-assistant knowledge base", () => {
  it("names no tenant in the system prompt", () => {
    expect(
      offendingTokens(buildAdminAssistantSystemPrompt(CTX)),
      "The admin assistant resolves the PLATFORM tokens (PennFit / " +
        "PennPilot) per tenant but not a tenant's own name, so a tenant " +
        "identity here reaches every other tenant's console verbatim. " +
        "Describe the operator's practice generically instead.",
    ).toEqual([]);
  });

  it("names no tenant in the offline fallback reply", () => {
    expect(offendingTokens(ADMIN_OFFLINE_FALLBACK_REPLY)).toEqual([]);
  });

  it("still carries the platform placeholders the I/O boundary resolves", () => {
    // The counterpart assertion: if someone "fixes" this file by hand-typing
    // CareMetric Breathe / CareMetric Copilot instead of leaving the
    // placeholders, a tenant that renamed its assistant stops seeing its own
    // name. The rename must stay the I/O boundary's job.
    const prompt = buildAdminAssistantSystemPrompt(CTX);
    expect(prompt).toContain("PennPilot");
    expect(prompt).toContain("PennFit");
  });
});
