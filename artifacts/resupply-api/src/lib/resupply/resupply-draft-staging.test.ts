import { describe, expect, it } from "vitest";

import {
  type DraftSeed,
  draftDedupKey,
  planDraftInserts,
} from "./resupply-draft-staging";

const seed = (
  patientId: string,
  category: string,
  nextEligibleDate: string | null = "2026-07-01",
): DraftSeed => ({ patientId, category, nextEligibleDate });

describe("draftDedupKey", () => {
  it("is stable for the same tuple and distinct across fields", () => {
    expect(draftDedupKey("p1", "mask", "2026-07-01")).toBe(
      "p1|mask|2026-07-01",
    );
    expect(draftDedupKey("p1", "mask", null)).toBe("p1|mask|");
    expect(draftDedupKey("p1", "mask", "2026-07-01")).not.toBe(
      draftDedupKey("p1", "cushion", "2026-07-01"),
    );
  });
});

describe("planDraftInserts", () => {
  it("inserts all when nothing exists", () => {
    const out = planDraftInserts(
      [seed("p1", "mask"), seed("p2", "cushion")],
      new Set(),
    );
    expect(out.toInsert).toHaveLength(2);
    expect(out.skipped).toBe(0);
  });

  it("skips seeds that already have an open draft", () => {
    const existing = new Set([draftDedupKey("p1", "mask", "2026-07-01")]);
    const out = planDraftInserts(
      [seed("p1", "mask"), seed("p2", "cushion")],
      existing,
    );
    expect(out.toInsert.map((s) => s.patientId)).toEqual(["p2"]);
    expect(out.skipped).toBe(1);
  });

  it("collapses duplicates within the incoming batch", () => {
    const out = planDraftInserts(
      [
        seed("p1", "mask"),
        seed("p1", "mask"),
        seed("p1", "mask", "2026-08-01"),
      ],
      new Set(),
    );
    // Same patient+category+date once; the different date is its own row.
    expect(out.toInsert).toHaveLength(2);
    expect(out.skipped).toBe(1);
  });

  it("treats a different next-eligible-date as a distinct draft", () => {
    const existing = new Set([draftDedupKey("p1", "mask", "2026-07-01")]);
    const out = planDraftInserts([seed("p1", "mask", "2026-10-01")], existing);
    expect(out.toInsert).toHaveLength(1);
    expect(out.skipped).toBe(0);
  });
});
