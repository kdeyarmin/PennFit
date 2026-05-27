import { describe, expect, it } from "vitest";

import { createAirviewAdapter } from "./index";

describe("createAirviewAdapter", () => {
  it("reports unavailable when no creds are present", () => {
    const adapter = createAirviewAdapter({});
    expect(adapter.source).toBe("resmed_airview");
    expect(adapter.availability()).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
  });

  it("returns an unavailable error (no fabricated snapshot) when not configured", async () => {
    const adapter = createAirviewAdapter({});
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "abc",
      windowDays: 14,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });

  it("reports configured when all creds are present", () => {
    const adapter = createAirviewAdapter({
      AIRVIEW_API_BASE_URL: "https://api.example.com",
      AIRVIEW_OAUTH_TOKEN_URL: "https://api.example.com/oauth/token",
      AIRVIEW_CLIENT_ID: "id",
      AIRVIEW_CLIENT_SECRET: "secret",
      AIRVIEW_DME_ID: "dme",
    });
    expect(adapter.availability()).toEqual({ status: "configured" });
  });
});
