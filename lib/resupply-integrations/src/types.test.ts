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

  it("has exactly four entries", () => {
    // Regression guard: adding a vendor without updating this count is a red flag.
    expect(INTEGRATION_SOURCES).toHaveLength(4);
  });

  it("includes react_health", () => {
    // Targeted membership check for the vendor added in this PR.
    expect(INTEGRATION_SOURCES).toContain("react_health");
  });

  it("lists react_health as the last entry", () => {
    // Order regression: the unified-package relies on stable ordering.
    expect(INTEGRATION_SOURCES[INTEGRATION_SOURCES.length - 1]).toBe(
      "react_health"
    );
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

  it("accepts react_health as a valid source", () => {
    // Validates the new vendor added in this PR is accepted end-to-end
    // through the Zod enum derived from INTEGRATION_SOURCES.
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
