// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { pickPatientTab } from "./patient-detail";

describe("pickPatientTab", () => {
  it("returns a known tab key unchanged (boards deep-link here)", () => {
    expect(pickPatientTab("device-data")).toBe("device-data");
    expect(pickPatientTab("billing")).toBe("billing");
  });

  it("falls back to the default tab for unknown / empty / missing values", () => {
    expect(pickPatientTab("not-a-tab")).toBe("timeline");
    expect(pickPatientTab("")).toBe("timeline");
    expect(pickPatientTab(null)).toBe("timeline");
    expect(pickPatientTab(undefined)).toBe("timeline");
  });
});
