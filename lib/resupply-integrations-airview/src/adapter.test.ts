import { describe, expect, it } from "vitest";

import { createAirviewAdapter } from "./index";

describe("createAirviewAdapter", () => {
  it("reports stub when no creds are present", () => {
    const adapter = createAirviewAdapter({});
    expect(adapter.source).toBe("resmed_airview");
    expect(adapter.availability()).toEqual({
      status: "stub",
      reason: "no_credentials",
    });
  });

  it("returns a stub snapshot in stub mode", async () => {
    const adapter = createAirviewAdapter({ AIRVIEW_STUB: "1" });
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "abc",
      windowDays: 14,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.source).toBe("resmed_airview");
      expect(result.snapshot.recentNights.length).toBe(14);
      expect(result.snapshot.compliance?.windowDays).toBe(14);
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
