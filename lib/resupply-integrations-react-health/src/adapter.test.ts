import { describe, expect, it } from "vitest";

import { createReactHealthAdapter } from "./index";

describe("createReactHealthAdapter", () => {
  it("reports stub when no creds are present", () => {
    const adapter = createReactHealthAdapter({});
    expect(adapter.source).toBe("react_health");
    expect(adapter.availability()).toEqual({
      status: "stub",
      reason: "no_credentials",
    });
  });

  it("returns a stub snapshot in stub mode", async () => {
    const adapter = createReactHealthAdapter({ REACT_HEALTH_STUB: "1" });
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "xyz",
      windowDays: 14,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.source).toBe("react_health");
      expect(result.snapshot.recentNights.length).toBe(14);
      expect(result.snapshot.compliance?.windowDays).toBe(14);
      expect(result.snapshot.settings?.deviceModel).toMatch(/Luna G3/);
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

  it("reports stub_mode reason when stub override is on", () => {
    const adapter = createReactHealthAdapter({
      REACT_HEALTH_API_BASE_URL: "https://api.example.com",
      REACT_HEALTH_OAUTH_TOKEN_URL: "https://api.example.com/oauth/token",
      REACT_HEALTH_CLIENT_ID: "id",
      REACT_HEALTH_CLIENT_SECRET: "secret",
      REACT_HEALTH_ACCOUNT_ID: "acct",
      REACT_HEALTH_STUB: "1",
    });
    expect(adapter.availability()).toEqual({
      status: "stub",
      reason: "stub_mode",
    });
  });
});
