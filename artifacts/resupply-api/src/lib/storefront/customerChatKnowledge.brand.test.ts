// Guards the signed-in customer chat knowledge base against tenant-brand
// leaks. Like the admin assistant KB, the static source keeps Penn*
// PLATFORM placeholders (PennBot / PennPilot / PennFit) that
// applyPlatformBrandingForOrg resolves at the I/O boundary — but a tenant
// identity (Penn Home Medical Supply, pennpaps.com) must not survive into
// another tenant's prompt when buildCustomerChatSystemPrompt is given that
// tenant's CompanyInfo.

import { describe, expect, it } from "vitest";

import type { CompanyInfo } from "../company-info";
import {
  buildCustomerChatSystemPrompt,
  customerOfflineFallbackReply,
} from "./customerChatKnowledge";

const TENANT_B: CompanyInfo = {
  name: "Acme Respiratory",
  legalName: "Acme Respiratory LLC",
  phoneE164: "+15551230000",
  phoneDisplay: "(555) 123-0000",
  supportPhoneE164: "+15551230000",
  supportPhoneDisplay: "(555) 123-0000",
  supportEmail: "help@acmeresp.com",
  generalEmail: "info@acmeresp.com",
  billingEmail: "billing@acmeresp.com",
  faxE164: null,
  websiteUrl: "https://acmeresp.com",
  supportHours: "Mon–Fri 8a–6p CT",
  assistantStorefrontName: "Acme Assistant",
  assistantAdminName: "Acme Copilot",
  address: null,
  organizationalNpi: null,
  source: "database",
};

const TENANT_TOKENS = ["pennpaps", "penn home medical", "penn paps"];

function offendingTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return TENANT_TOKENS.filter(
    (t) => lower.includes(t) || compact.includes(t.replace(/[^a-z0-9]/g, "")),
  );
}

const EMPTY_CTX = {
  displayName: null,
  memberSince: null,
  totalShipments: 0,
  latestOrder: null,
  activeSubscriptionCount: 0,
  device: null,
};

describe("customer-chat knowledge base", () => {
  it("names no seed tenant in the prompt when CompanyInfo is threaded", () => {
    expect(
      offendingTokens(buildCustomerChatSystemPrompt(EMPTY_CTX, TENANT_B)),
      "applyCompanyIdentityToText must rewrite seed tenant contact/name " +
        "before the prompt reaches a non-seed tenant's signed-in chat.",
    ).toEqual([]);
  });

  it("names no seed tenant in the offline fallback when CompanyInfo is threaded", () => {
    expect(offendingTokens(customerOfflineFallbackReply(TENANT_B))).toEqual([]);
  });

  it("still carries the platform placeholders the I/O boundary resolves", () => {
    const prompt = buildCustomerChatSystemPrompt(EMPTY_CTX);
    expect(prompt).toContain("PennBot");
  });
});
