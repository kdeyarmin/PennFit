import { describe, expect, it } from "vitest";

import {
  INTEGRATION_SOURCES,
  integrationSnapshotSchema,
} from "./index";

describe("INTEGRATION_SOURCES", () => {
  it("includes the three target vendors", () => {
    expect(INTEGRATION_SOURCES).toEqual([
      "resmed_airview",
      "philips_care",
      "health_connect",
    ]);
  });
});

describe("integrationSnapshotSchema", () => {
  it("accepts a minimal valid snapshot", () => {
    const parsed = integrationSnapshotSchema.parse({
      source: "resmed_airview",
      partnerPatientId: "abc-123",
      settings: null,
      compliance: null,
      recentNights: [],
      supplies: [],
    });
    expect(parsed.source).toBe("resmed_airview");
  });

  it("rejects a bad night-date format", () => {
    const result = integrationSnapshotSchema.safeParse({
      source: "philips_care",
      partnerPatientId: "x",
      settings: null,
      compliance: null,
      recentNights: [
        {
          nightDate: "2026/01/02",
          usageMinutes: null,
          ahi: null,
          leakRateLMin: null,
          pressureP95Cmh2o: null,
        },
      ],
      supplies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown source", () => {
    const result = integrationSnapshotSchema.safeParse({
      source: "made_up",
      partnerPatientId: "x",
      settings: null,
      compliance: null,
      recentNights: [],
      supplies: [],
    });
    expect(result.success).toBe(false);
  });
});
