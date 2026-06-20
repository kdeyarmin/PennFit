// Unit tests for the smart-trigger rule library (Phase E.2).
//
// Pure-function rules → pure-function tests. No DB, no network.

import { describe, it, expect } from "vitest";

import {
  evaluateAhiElevated,
  evaluateAhiRising,
  evaluateAll,
  evaluateCushionWear,
  evaluateLeakRising,
  evaluateNonAdherent30d,
  evaluatePressureAtMax,
  evaluateUsageDropping,
  evaluateUsageErratic,
  type NightDatum,
} from "./index";

function makeNights(
  start: string,
  count: number,
  shape: (i: number) => Partial<NightDatum>,
): NightDatum[] {
  const out: NightDatum[] = [];
  const startD = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const d = new Date(startD);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    out.push({
      date,
      usageMinutes: null,
      ahi: null,
      leakRateLMin: null,
      pressureP95Cmh2o: null,
      ...shape(i),
    });
  }
  return out;
}

describe("evaluateLeakRising", () => {
  it("returns null when fewer than 10 nights of data", () => {
    const nights = makeNights("2026-05-01", 5, () => ({ leakRateLMin: 5 }));
    expect(evaluateLeakRising(nights)).toBeNull();
  });

  it("returns null when leak is stable", () => {
    const nights = makeNights("2026-05-01", 14, () => ({ leakRateLMin: 5 }));
    expect(evaluateLeakRising(nights)).toBeNull();
  });

  it("returns null when leak is rising but stays below the noise floor", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      leakRateLMin: i < 7 ? 0.5 : 1.5,
    }));
    expect(evaluateLeakRising(nights)).toBeNull();
  });

  it("fires when back half is ≥30% higher AND above the noise floor", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      leakRateLMin: i < 7 ? 4 : 6,
    }));
    const r = evaluateLeakRising(nights);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("leak_rising");
    expect(r?.windowEndDate).toBe("2026-05-14");
  });
});

describe("evaluateUsageDropping", () => {
  it("requires the back half to be below the adherence threshold", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      usageMinutes: i < 7 ? 360 : 300,
    }));
    // Both halves stay above 240 → not flagged.
    expect(evaluateUsageDropping(nights)).toBeNull();
  });

  it("fires when the back half drops below 240 AND is ≤70% of the front", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      usageMinutes: i < 7 ? 360 : 220,
    }));
    const r = evaluateUsageDropping(nights);
    expect(r?.kind).toBe("usage_dropping");
  });
});

describe("evaluateCushionWear", () => {
  it("requires BOTH leak rising AND AHI rising", () => {
    // Leak rising, AHI flat → not cushion_wear.
    const nights = makeNights("2026-05-01", 14, (i) => ({
      leakRateLMin: i < 7 ? 4 : 6,
      ahi: 1,
    }));
    expect(evaluateCushionWear(nights)).toBeNull();
  });

  it("fires when both signals trend up", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      leakRateLMin: i < 7 ? 4 : 6,
      ahi: i < 7 ? 1 : 2,
    }));
    const r = evaluateCushionWear(nights);
    expect(r?.kind).toBe("cushion_wear");
  });
});

describe("evaluatePressureAtMax", () => {
  it("returns null when the device max is unknown", () => {
    const nights = makeNights("2026-05-01", 7, () => ({
      pressureP95Cmh2o: 20,
      ahi: 8,
    }));
    expect(evaluatePressureAtMax(nights)).toBeNull();
    expect(evaluatePressureAtMax(nights, {})).toBeNull();
    expect(
      evaluatePressureAtMax(nights, { deviceMaxPressureCmh2o: null }),
    ).toBeNull();
  });

  it("returns null when pressure sits at max but AHI is controlled", () => {
    // Pegged at 20 every night, but events are well controlled — that's
    // a fine APAP that simply runs near its cap. Must NOT fire.
    const nights = makeNights("2026-05-01", 7, () => ({
      pressureP95Cmh2o: 20,
      ahi: 2,
    }));
    expect(
      evaluatePressureAtMax(nights, { deviceMaxPressureCmh2o: 20 }),
    ).toBeNull();
  });

  it("returns null when AHI is high but pressure is well below max", () => {
    const nights = makeNights("2026-05-01", 7, () => ({
      pressureP95Cmh2o: 12,
      ahi: 9,
    }));
    expect(
      evaluatePressureAtMax(nights, { deviceMaxPressureCmh2o: 20 }),
    ).toBeNull();
  });

  it("fires when pressure is pegged at max AND residual AHI is elevated", () => {
    const nights = makeNights("2026-05-01", 7, () => ({
      pressureP95Cmh2o: 19.5, // within 1.0 of the 20 cmH2O ceiling
      ahi: 8,
    }));
    const r = evaluatePressureAtMax(nights, { deviceMaxPressureCmh2o: 20 });
    expect(r?.kind).toBe("pressure_at_max");
    expect(r?.windowEndDate).toBe("2026-05-07");
  });

  it("returns null without enough recent nights of pressure data", () => {
    const nights = makeNights("2026-05-01", 4, () => ({
      pressureP95Cmh2o: 20,
      ahi: 8,
    }));
    expect(
      evaluatePressureAtMax(nights, { deviceMaxPressureCmh2o: 20 }),
    ).toBeNull();
  });
});

describe("evaluateAhiRising", () => {
  it("fires on a worsening trend below the absolute alarm", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      ahi: i < 7 ? 2 : 4, // 2x rise, back half (4) under the ahi=5 alarm
    }));
    const r = evaluateAhiRising(nights);
    expect(r?.kind).toBe("ahi_rising");
  });

  it("does not fire when the back half is already over the absolute alarm", () => {
    // ahi_elevated owns this case — ahi_rising must defer.
    const nights = makeNights("2026-05-01", 14, (i) => ({
      ahi: i < 7 ? 3 : 6,
    }));
    expect(evaluateAhiRising(nights)).toBeNull();
  });

  it("does not fire on jitter near zero", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      ahi: i < 7 ? 0.5 : 1.5,
    }));
    expect(evaluateAhiRising(nights)).toBeNull();
  });
});

describe("evaluateUsageErratic", () => {
  it("fires on binge-and-skip volatility", () => {
    // Alternating skipped (0 min) and full (480 min) nights — high CV,
    // clear mix of skip + full nights.
    const nights = makeNights("2026-05-01", 14, (i) => ({
      usageMinutes: i % 2 === 0 ? 0 : 480,
    }));
    const r = evaluateUsageErratic(nights);
    expect(r?.kind).toBe("usage_erratic");
  });

  it("does not fire on a steady borderline user", () => {
    const nights = makeNights("2026-05-01", 14, () => ({
      usageMinutes: 210, // consistent, low variance
    }));
    expect(evaluateUsageErratic(nights)).toBeNull();
  });

  it("does not fire without both skip and full nights", () => {
    // Variance present but no near-zero "skip" nights.
    const nights = makeNights("2026-05-01", 14, (i) => ({
      usageMinutes: i % 2 === 0 ? 250 : 480,
    }));
    expect(evaluateUsageErratic(nights)).toBeNull();
  });
});

describe("evaluateAll", () => {
  it("includes pressure_at_max only when the device context is supplied", () => {
    const nights = makeNights("2026-05-01", 7, () => ({
      pressureP95Cmh2o: 20,
      ahi: 8,
    }));
    expect(evaluateAll(nights).map((p) => p.kind)).not.toContain(
      "pressure_at_max",
    );
    expect(
      evaluateAll(nights, { deviceMaxPressureCmh2o: 20 }).map((p) => p.kind),
    ).toContain("pressure_at_max");
  });

  it("returns the multi-rule fan-out — leak_rising AND cushion_wear together", () => {
    const nights = makeNights("2026-05-01", 14, (i) => ({
      leakRateLMin: i < 7 ? 4 : 6,
      ahi: i < 7 ? 1 : 2,
    }));
    const proposals = evaluateAll(nights);
    const kinds = proposals.map((p) => p.kind).sort();
    // Both leak_rising AND cushion_wear should fire on the same data.
    expect(kinds).toContain("leak_rising");
    expect(kinds).toContain("cushion_wear");
  });

  it("returns empty when nothing fires", () => {
    const nights = makeNights("2026-05-01", 14, () => ({
      leakRateLMin: 1,
      ahi: 1,
      usageMinutes: 480,
      pressureP95Cmh2o: 10,
    }));
    expect(evaluateAll(nights)).toEqual([]);
  });
});

describe("evaluateAhiElevated", () => {
  it("returns null on fewer than 5 nights of data", () => {
    const nights = makeNights("2026-05-11", 4, () => ({ ahi: 7 }));
    expect(evaluateAhiElevated(nights)).toBeNull();
  });

  it("returns null when no night breaches the AHI threshold", () => {
    const nights = makeNights("2026-05-11", 7, () => ({ ahi: 3 }));
    expect(evaluateAhiElevated(nights)).toBeNull();
  });

  it("returns null with only 2 breaches in the window", () => {
    const nights = makeNights("2026-05-11", 7, (i) => ({
      ahi: i < 2 ? 8 : 3,
    }));
    expect(evaluateAhiElevated(nights)).toBeNull();
  });

  it("fires with exactly 3 breaches in the 7-night window", () => {
    const nights = makeNights("2026-05-11", 7, (i) => ({
      ahi: i < 3 ? 8 : 3,
    }));
    const proposal = evaluateAhiElevated(nights);
    expect(proposal?.kind).toBe("ahi_elevated");
    expect(proposal?.windowStartDate).toBe("2026-05-11");
    expect(proposal?.windowEndDate).toBe("2026-05-17");
  });

  it("ignores nights with null AHI when counting breaches", () => {
    const nights = makeNights("2026-05-11", 7, (i) => ({
      ahi: i < 2 ? 8 : null,
    }));
    expect(evaluateAhiElevated(nights)).toBeNull();
  });

  it("considers only the most recent 7 nights even when more data is supplied", () => {
    // First 7 nights all high; last 7 all controlled. Should NOT fire.
    const nights = makeNights("2026-04-01", 14, (i) => ({
      ahi: i < 7 ? 8 : 2,
    }));
    expect(evaluateAhiElevated(nights)).toBeNull();
  });
});

describe("evaluateNonAdherent30d", () => {
  it("returns null with fewer than 21 nights of usage data", () => {
    const nights = makeNights("2026-04-28", 20, () => ({ usageMinutes: 0 }));
    expect(evaluateNonAdherent30d(nights)).toBeNull();
  });

  it("returns null when adherence is 100%", () => {
    const nights = makeNights("2026-04-18", 30, () => ({
      usageMinutes: 480,
    }));
    expect(evaluateNonAdherent30d(nights)).toBeNull();
  });

  it("returns null when adherence is exactly 70%", () => {
    // 21 of 30 adherent → exactly 0.70; not < 0.70, so doesn't fire.
    const nights = makeNights("2026-04-18", 30, (i) => ({
      usageMinutes: i < 21 ? 300 : 60,
    }));
    expect(evaluateNonAdherent30d(nights)).toBeNull();
  });

  it("fires when adherence drops below 70%", () => {
    // 20 of 30 adherent → 0.667; below threshold.
    const nights = makeNights("2026-04-18", 30, (i) => ({
      usageMinutes: i < 20 ? 300 : 60,
    }));
    const proposal = evaluateNonAdherent30d(nights);
    expect(proposal?.kind).toBe("non_adherent_30d");
    expect(proposal?.windowStartDate).toBe("2026-04-18");
    expect(proposal?.windowEndDate).toBe("2026-05-17");
  });

  it("requires ≥21 NON-null usage readings, not just 21 input nights", () => {
    // 30 nights, but 12 have null usage → only 18 counted. Below the
    // 21 floor, so we shouldn't fire even though the 18 we have are
    // all sub-threshold.
    const nights = makeNights("2026-04-18", 30, (i) => ({
      usageMinutes: i < 18 ? 60 : null,
    }));
    expect(evaluateNonAdherent30d(nights)).toBeNull();
  });
});
