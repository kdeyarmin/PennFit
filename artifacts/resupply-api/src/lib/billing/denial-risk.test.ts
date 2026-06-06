import { describe, expect, it } from "vitest";

import { scoreDenialRiskItems, type DenialRiskStat } from "./denial-risk";

const PAYER = "Highmark";

describe("scoreDenialRiskItems", () => {
  it("warns when a HCPCS is at/above the default rate + sample", () => {
    const stats: DenialRiskStat[] = [
      { hcpcsCode: "E0601", decisions: 50, denials: 19 }, // 38%
    ];
    const items = scoreDenialRiskItems(PAYER, stats);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("warning");
    expect(items[0]!.key).toBe("denial_risk:E0601");
    expect(items[0]!.detail).toContain("Highmark denied 38% of recent E0601");
    expect(items[0]!.detail).toContain("n=50");
  });

  it("never emits an error severity (purely advisory)", () => {
    const items = scoreDenialRiskItems(PAYER, [
      { hcpcsCode: "A7034", decisions: 100, denials: 100 },
    ]);
    expect(items.every((i) => i.severity === "warning")).toBe(true);
  });

  it("stays silent below the minimum sample even at a high rate", () => {
    const items = scoreDenialRiskItems(PAYER, [
      { hcpcsCode: "E0601", decisions: 9, denials: 9 }, // 100% but n<10
    ]);
    expect(items).toEqual([]);
  });

  it("stays silent below the warn threshold", () => {
    const items = scoreDenialRiskItems(PAYER, [
      { hcpcsCode: "E0601", decisions: 100, denials: 10 }, // 10% < 20%
    ]);
    expect(items).toEqual([]);
  });

  it("includes a row exactly at the threshold (20%, n=10)", () => {
    const items = scoreDenialRiskItems(PAYER, [
      { hcpcsCode: "E0601", decisions: 10, denials: 2 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.detail).toContain("20%");
  });

  it("orders multiple risky HCPCS highest-rate first, then code asc", () => {
    const items = scoreDenialRiskItems(PAYER, [
      { hcpcsCode: "A7034", decisions: 40, denials: 12 }, // 30%
      { hcpcsCode: "E0601", decisions: 40, denials: 24 }, // 60%
      { hcpcsCode: "A7032", decisions: 40, denials: 12 }, // 30% (tie → code asc)
    ]);
    expect(items.map((i) => i.key)).toEqual([
      "denial_risk:E0601",
      "denial_risk:A7032",
      "denial_risk:A7034",
    ]);
  });

  it("respects custom thresholds", () => {
    const stats: DenialRiskStat[] = [
      { hcpcsCode: "E0601", decisions: 5, denials: 2 }, // 40%, n=5
    ];
    expect(scoreDenialRiskItems(PAYER, stats)).toEqual([]);
    const tuned = scoreDenialRiskItems(PAYER, stats, {
      minSample: 5,
      warnRate: 0.35,
    });
    expect(tuned).toHaveLength(1);
  });

  it("returns nothing for empty stats and never divides by zero", () => {
    expect(scoreDenialRiskItems(PAYER, [])).toEqual([]);
    expect(
      scoreDenialRiskItems(PAYER, [
        { hcpcsCode: "E0601", decisions: 0, denials: 0 },
      ]),
    ).toEqual([]);
  });
});
