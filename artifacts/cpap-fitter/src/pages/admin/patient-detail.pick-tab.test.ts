// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  pickPatientTab,
  PATIENT_TABS,
  PATIENT_TAB_GROUPS,
} from "./patient-detail";

describe("PATIENT_TAB_GROUPS", () => {
  it("covers every tab exactly once (no missing or duplicated sections)", () => {
    const grouped = PATIENT_TAB_GROUPS.flatMap((g) => g.tabs);
    // No duplicates.
    expect(new Set(grouped).size).toBe(grouped.length);
    // Same set as the canonical tab list.
    expect([...grouped].sort()).toEqual([...PATIENT_TABS].sort());
  });
});

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
