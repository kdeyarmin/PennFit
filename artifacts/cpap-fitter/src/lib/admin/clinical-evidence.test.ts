import { describe, it, expect } from "vitest";

import {
  buildClinicalEvidenceSeries,
  type EvidenceNight,
} from "./clinical-evidence";

function night(
  date: string,
  fields: Partial<Omit<EvidenceNight, "nightDate">> = {},
): EvidenceNight {
  return {
    nightDate: date,
    usageMinutes: null,
    ahi: null,
    leakRateLMin: null,
    pressureP95Cmh2o: null,
    ...fields,
  };
}

describe("buildClinicalEvidenceSeries", () => {
  it("returns null for a non-clinical (patient-facing) kind", () => {
    expect(
      buildClinicalEvidenceSeries(
        "leak_rising",
        [],
        "2026-06-01",
        "2026-06-14",
      ),
    ).toBeNull();
  });

  it("maps pressure_at_max to the P95 pressure series, oldest→newest", () => {
    // Deliberately out of order; window excludes the 05-31 night.
    const nights = [
      night("2026-06-03", { pressureP95Cmh2o: 19.8 }),
      night("2026-05-31", { pressureP95Cmh2o: 12.0 }),
      night("2026-06-01", { pressureP95Cmh2o: 19.5 }),
      night("2026-06-02", { pressureP95Cmh2o: 19.9 }),
    ];
    const s = buildClinicalEvidenceSeries(
      "pressure_at_max",
      nights,
      "2026-06-01",
      "2026-06-03",
    );
    expect(s).not.toBeNull();
    expect(s!.label).toBe("P95 pressure");
    expect(s!.unit).toBe("cmH₂O");
    // chronological within window, 05-31 excluded
    expect(s!.values).toEqual([19.5, 19.9, 19.8]);
    expect(s!.latest).toBe(19.8);
    expect(s!.sampleCount).toBe(3);
  });

  it("maps the adherence signals to nightly usage HOURS", () => {
    const nights = [
      night("2026-06-01", { usageMinutes: 480 }),
      night("2026-06-02", { usageMinutes: 0 }),
    ];
    const s = buildClinicalEvidenceSeries(
      "usage_erratic",
      nights,
      "2026-06-01",
      "2026-06-02",
    );
    expect(s!.label).toBe("Usage");
    expect(s!.values).toEqual([8, 0]);
    expect(s!.latest).toBe(0);
  });

  it("keeps missing nights as null gaps and counts only real samples", () => {
    const nights = [
      night("2026-06-01", { ahi: 4 }),
      night("2026-06-02", {}), // no AHI recorded
      night("2026-06-03", { ahi: 6 }),
    ];
    const s = buildClinicalEvidenceSeries(
      "ahi_rising",
      nights,
      "2026-06-01",
      "2026-06-03",
    );
    expect(s!.values).toEqual([4, null, 6]);
    expect(s!.latest).toBe(6);
    expect(s!.sampleCount).toBe(2);
  });

  it("returns an empty series when no nights fall in the window", () => {
    const nights = [night("2026-05-01", { ahi: 3 })];
    const s = buildClinicalEvidenceSeries(
      "ahi_elevated",
      nights,
      "2026-06-01",
      "2026-06-14",
    );
    expect(s!.values).toEqual([]);
    expect(s!.sampleCount).toBe(0);
    expect(s!.latest).toBeNull();
  });
});
