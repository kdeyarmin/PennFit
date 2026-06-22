import { describe, expect, it } from "vitest";

import { aggregateAdrOutcomes } from "./adr-analytics";

describe("aggregateAdrOutcomes", () => {
  it("is empty with a null win rate when there are no rows", () => {
    const a = aggregateAdrOutcomes([]);
    expect(a.totals.responded).toBe(0);
    expect(a.totals.decided).toBe(0);
    expect(a.totals.winRate).toBeNull();
    expect(a.bySource).toEqual([]);
  });

  it("counts favorable + partial as wins, excludes pending from the rate", () => {
    const a = aggregateAdrOutcomes([
      { source: "tpe", outcome: "favorable" },
      { source: "tpe", outcome: "partial" },
      { source: "tpe", outcome: "unfavorable" },
      { source: "tpe", outcome: "pending" },
    ]);
    expect(a.totals.responded).toBe(4);
    expect(a.totals.decided).toBe(3); // pending not decided
    expect(a.totals.favorable).toBe(1);
    expect(a.totals.partial).toBe(1);
    expect(a.totals.unfavorable).toBe(1);
    expect(a.totals.winRate).toBeCloseTo(2 / 3);
  });

  it("treats withdrawn as not-decided (neither win nor loss)", () => {
    const a = aggregateAdrOutcomes([
      { source: "rac", outcome: "favorable" },
      { source: "rac", outcome: "withdrawn" },
    ]);
    expect(a.totals.decided).toBe(1);
    expect(a.totals.winRate).toBe(1);
  });

  it("buckets per source, busiest first", () => {
    const a = aggregateAdrOutcomes([
      { source: "tpe", outcome: "favorable" },
      { source: "tpe", outcome: "unfavorable" },
      { source: "upic", outcome: "favorable" },
    ]);
    expect(a.bySource.map((b) => b.source)).toEqual(["tpe", "upic"]);
    const tpe = a.bySource.find((b) => b.source === "tpe")!;
    expect(tpe.total).toBe(2);
    expect(tpe.favorable).toBe(1);
    expect(tpe.unfavorable).toBe(1);
  });
});
