import { describe, expect, it } from "vitest";

import {
  classifyPayerSlug,
  percentileSorted,
  summarizeOopBySlug,
  type OopSample,
} from "./learn";

describe("classifyPayerSlug", () => {
  it("maps common payer names to slugs", () => {
    expect(classifyPayerSlug("Aetna Better Health")).toBe("aetna");
    expect(classifyPayerSlug("UnitedHealthcare PPO")).toBe("united");
    expect(classifyPayerSlug("Anthem Blue Cross")).toBe("bcbs");
    expect(classifyPayerSlug("Cigna HealthSpring")).toBe("cigna");
    expect(classifyPayerSlug("Humana Gold")).toBe("humana");
    expect(classifyPayerSlug("Kaiser Permanente")).toBe("kaiser");
    expect(classifyPayerSlug("TRICARE East")).toBe("tricare");
    expect(classifyPayerSlug("Pennsylvania Medicaid")).toBe("medicaid");
  });

  it("prefers Medicare Advantage over plain Medicare", () => {
    expect(classifyPayerSlug("Humana Medicare Advantage")).toBe(
      "medicare_advantage",
    );
    expect(classifyPayerSlug("Medicare Part B")).toBe("medicare");
  });

  it("returns null for an unrecognized payer", () => {
    expect(classifyPayerSlug("Some Random TPA LLC")).toBeNull();
    expect(classifyPayerSlug("")).toBeNull();
  });
});

describe("percentileSorted", () => {
  it("computes nearest-rank percentiles", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentileSorted(xs, 0.5)).toBe(50);
    expect(percentileSorted(xs, 0.9)).toBe(90);
    expect(percentileSorted(xs, 1)).toBe(100);
  });
  it("handles empty + single-element arrays", () => {
    expect(percentileSorted([], 0.5)).toBe(0);
    expect(percentileSorted([42], 0.9)).toBe(42);
  });
});

describe("summarizeOopBySlug", () => {
  const sample = (payerName: string, oopCents: number): OopSample => ({
    payerName,
    oopCents,
  });

  it("rolls classified samples into per-slug P50/P90 with a min sample", () => {
    const samples: OopSample[] = [];
    // 12 Aetna claims at 100..1200 cents.
    for (let i = 1; i <= 12; i++) samples.push(sample("Aetna", i * 100));
    // Only 3 Cigna claims → below the default minSample of 10 → dropped.
    for (let i = 1; i <= 3; i++) samples.push(sample("Cigna", i * 100));
    // Unrecognized payer → dropped.
    samples.push(sample("Mystery TPA", 9999));

    const out = summarizeOopBySlug(samples);
    expect(out.map((s) => s.slug)).toEqual(["aetna"]);
    const aetna = out[0]!;
    expect(aetna.sampleSize).toBe(12);
    // nearest-rank: p50 = ceil(.5*12)=6th → 600; p90 = ceil(.9*12)=11th → 1100
    expect(aetna.p50Cents).toBe(600);
    expect(aetna.p90Cents).toBe(1100);
  });

  it("respects a custom minSample", () => {
    const samples = [sample("Cigna", 100), sample("Cigna", 300)];
    expect(summarizeOopBySlug(samples)).toEqual([]);
    const out = summarizeOopBySlug(samples, 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe("cigna");
  });

  it("floors negative OOP at zero", () => {
    const samples = Array.from({ length: 10 }, () => sample("Aetna", -500));
    const out = summarizeOopBySlug(samples);
    expect(out[0]!.p50Cents).toBe(0);
  });
});
