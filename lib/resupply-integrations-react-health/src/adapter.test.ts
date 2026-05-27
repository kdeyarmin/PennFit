import { describe, expect, it } from "vitest";

import { createReactHealthAdapter } from "./index";

describe("createReactHealthAdapter", () => {
  it("reports unavailable when no creds are present", () => {
    const adapter = createReactHealthAdapter({});
    expect(adapter.source).toBe("react_health");
    expect(adapter.availability()).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
  });

  it("returns an unavailable error (no fabricated snapshot) when not configured", async () => {
    const adapter = createReactHealthAdapter({});
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "xyz",
      windowDays: 14,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });

  it("reports configured when all creds are present", () => {
    const adapter = createReactHealthAdapter({
      REACT_HEALTH_API_BASE_URL: "https://api.example.com",
      REACT_HEALTH_OAUTH_TOKEN_URL: "https://api.example.com/oauth/token",
      REACT_HEALTH_CLIENT_ID: "id",
      REACT_HEALTH_CLIENT_SECRET: "secret",
      REACT_HEALTH_ACCOUNT_ID: "acct",
    });
    expect(adapter.availability()).toEqual({ status: "configured" });
  });
});
