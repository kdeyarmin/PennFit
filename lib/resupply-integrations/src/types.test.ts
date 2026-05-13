import { describe, expect, it } from "vitest";

import {
  INTEGRATION_SOURCES,
  integrationSnapshotSchema,
} from "./index";

describe("INTEGRATION_SOURCES", () => {
  it("includes the expected target vendors", () => {
    // Exact list — keep this in sync as new vendor adapters land.
    // Order matches the unified-package declaration so the assertion
    // catches accidental reorderings.
    expect(INTEGRATION_SOURCES).toEqual([
      "resmed_airview",
      "philips_care",
      "health_connect",
      "react_health",
    ]);
  });

  it("contains exactly four sources", () => {
    // Regression guard: any accidental addition or removal of a source
    // should fail here before it silently drifts past review.
    expect(INTEGRATION_SOURCES).toHaveLength(4);
  });

  it("includes react_health as a recognised source", () => {
    // Targeted assertion for the vendor added in this PR (3B Medical /
    // iCode Connect / Luna G3 / Lumin ecosystem).
    expect(INTEGRATION_SOURCES).toContain("react_health");
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

  it("accepts react_health as a valid snapshot source", () => {
    // Validates that the schema's z.enum is derived from the updated
    // INTEGRATION_SOURCES tuple that now includes react_health.
    const result = integrationSnapshotSchema.safeParse({
      source: "react_health",
      partnerPatientId: "rh-patient-001",
      settings: null,
      compliance: null,
      recentNights: [],
      supplies: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("react_health");
    }
  });
});
