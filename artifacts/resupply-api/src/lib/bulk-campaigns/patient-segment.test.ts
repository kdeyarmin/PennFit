// Tests for the composable patient-segment filter spec.

import { describe, it, expect } from "vitest";

import {
  patientSegmentFilterSchema,
  segmentHasEquipmentCriteria,
  summarizePatientSegment,
  type PatientSegmentFilter,
} from "./patient-segment";

describe("patientSegmentFilterSchema", () => {
  it("rejects an empty segment (no criteria)", () => {
    const r = patientSegmentFilterSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("accepts a single criterion", () => {
    const r = patientSegmentFilterSchema.safeParse({ therapyFailing: true });
    expect(r.success).toBe(true);
  });

  it("accepts equipment + payer + recency together", () => {
    const r = patientSegmentFilterSchema.safeParse({
      manufacturers: ["ResMed", "Philips"],
      deviceClasses: ["cpap", "bipap"],
      equipmentModelContains: "DreamWear",
      insurancePayer: "Medicare",
      notContactedInDays: 90,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown device class", () => {
    const r = patientSegmentFilterSchema.safeParse({
      deviceClasses: ["spaceship"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = patientSegmentFilterSchema.safeParse({
      therapyFailing: true,
      includePastPatients: true,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-positive / out-of-range notContactedInDays", () => {
    expect(
      patientSegmentFilterSchema.safeParse({ notContactedInDays: 0 }).success,
    ).toBe(false);
    expect(
      patientSegmentFilterSchema.safeParse({ notContactedInDays: 99999 })
        .success,
    ).toBe(false);
  });
});

describe("segmentHasEquipmentCriteria", () => {
  it("is true when any equipment field is set", () => {
    expect(segmentHasEquipmentCriteria({ manufacturers: ["ResMed"] })).toBe(
      true,
    );
    expect(segmentHasEquipmentCriteria({ deviceClasses: ["cpap"] })).toBe(true);
    expect(segmentHasEquipmentCriteria({ equipmentModelContains: "P10" })).toBe(
      true,
    );
  });

  it("is false when only non-equipment fields are set", () => {
    expect(
      segmentHasEquipmentCriteria({
        therapyFailing: true,
        insurancePayer: "Aetna",
        notContactedInDays: 30,
      }),
    ).toBe(false);
  });
});

describe("summarizePatientSegment", () => {
  it("renders a PHI-free one-liner of the criteria", () => {
    const f: PatientSegmentFilter = {
      manufacturers: ["ResMed"],
      deviceClasses: ["bipap"],
      equipmentModelContains: "DreamWear",
      therapyFailing: true,
      insurancePayer: "Medicare",
      notContactedInDays: 60,
    };
    const s = summarizePatientSegment(f);
    expect(s).toContain("make: ResMed");
    expect(s).toContain("BiPAP");
    expect(s).toContain('model contains "DreamWear"');
    expect(s).toContain("failing therapy");
    expect(s).toContain("payer: Medicare");
    expect(s).toContain("not contacted in 60d");
  });
});
