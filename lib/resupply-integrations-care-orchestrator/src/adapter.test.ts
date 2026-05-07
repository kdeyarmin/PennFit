import { describe, expect, it } from "vitest";

import { createCareOrchestratorAdapter } from "./index";

describe("createCareOrchestratorAdapter", () => {
  it("reports stub when no creds are present", () => {
    const adapter = createCareOrchestratorAdapter({});
    expect(adapter.source).toBe("philips_care");
    expect(adapter.availability()).toEqual({
      status: "stub",
      reason: "no_credentials",
    });
  });

  it("returns a stub snapshot in stub mode", async () => {
    const adapter = createCareOrchestratorAdapter({
      CARE_ORCHESTRATOR_STUB: "1",
    });
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "abc",
      windowDays: 30,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.source).toBe("philips_care");
      expect(result.snapshot.recentNights.length).toBe(30);
    }
  });

  it("reports configured when all creds are present", () => {
    const adapter = createCareOrchestratorAdapter({
      CARE_ORCHESTRATOR_API_BASE_URL: "https://api.example.com",
      CARE_ORCHESTRATOR_OAUTH_TOKEN_URL:
        "https://api.example.com/oauth/token",
      CARE_ORCHESTRATOR_CLIENT_ID: "id",
      CARE_ORCHESTRATOR_CLIENT_SECRET: "secret",
      CARE_ORCHESTRATOR_PARTNER_ID: "partner",
    });
    expect(adapter.availability()).toEqual({ status: "configured" });
  });
});
