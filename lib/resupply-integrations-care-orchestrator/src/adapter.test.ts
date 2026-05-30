import { describe, expect, it } from "vitest";

import { createCareOrchestratorAdapter } from "./index";

describe("createCareOrchestratorAdapter", () => {
  it("reports unavailable when no creds are present", () => {
    const adapter = createCareOrchestratorAdapter({});
    expect(adapter.source).toBe("philips_care");
    expect(adapter.availability()).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
  });

  it("returns an unavailable error (no fabricated snapshot) when not configured", async () => {
    const adapter = createCareOrchestratorAdapter({});
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "abc",
      windowDays: 30,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });

  it("reports configured when all creds are present", () => {
    const adapter = createCareOrchestratorAdapter({
      CARE_ORCHESTRATOR_API_BASE_URL: "https://api.example.com",
      CARE_ORCHESTRATOR_OAUTH_TOKEN_URL: "https://api.example.com/oauth/token",
      CARE_ORCHESTRATOR_CLIENT_ID: "id",
      CARE_ORCHESTRATOR_CLIENT_SECRET: "secret",
      CARE_ORCHESTRATOR_PARTNER_ID: "partner",
    });
    expect(adapter.availability()).toEqual({ status: "configured" });
  });
});
