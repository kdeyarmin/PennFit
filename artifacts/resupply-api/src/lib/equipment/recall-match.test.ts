// Pure-function tests for the equipment-recall match engine.
// Covers every match-criterion branch the scan endpoint relies on.

import { describe, it, expect } from "vitest";

import { recallMatchesAsset } from "./recall-match";

describe("recallMatchesAsset — manufacturer gate", () => {
  it("matches when manufacturer agrees (exact case)", () => {
    expect(
      recallMatchesAsset({
        asset: { manufacturer: "Philips", model: "DreamStation", serialNumber: "S1" },
        recall: { manufacturer: "Philips", modelMatch: null, serialMatch: null },
      }),
    ).toBe(true);
  });

  it("matches when manufacturer agrees case-insensitively", () => {
    expect(
      recallMatchesAsset({
        asset: { manufacturer: "philips", model: "DreamStation", serialNumber: "S1" },
        recall: { manufacturer: "PHILIPS", modelMatch: null, serialMatch: null },
      }),
    ).toBe(true);
  });

  it("rejects when manufacturer differs", () => {
    expect(
      recallMatchesAsset({
        asset: { manufacturer: "ResMed", model: "AirSense 10", serialNumber: "R9" },
        recall: { manufacturer: "Philips", modelMatch: null, serialMatch: null },
      }),
    ).toBe(false);
  });
});

describe("recallMatchesAsset — model gate", () => {
  it("matches when modelMatch is null (any model)", () => {
    expect(
      recallMatchesAsset({
        asset: { manufacturer: "Philips", model: "DreamStation 2", serialNumber: "S1" },
        recall: { manufacturer: "Philips", modelMatch: null, serialMatch: null },
      }),
    ).toBe(true);
  });

  it("matches when model agrees (case-insensitive)", () => {
    expect(
      recallMatchesAsset({
        asset: { manufacturer: "Philips", model: "DreamStation", serialNumber: "S1" },
        recall: {
          manufacturer: "Philips",
          modelMatch: "dreamstation",
          serialMatch: null,
        },
      }),
    ).toBe(true);
  });

  it("rejects when model differs", () => {
    expect(
      recallMatchesAsset({
        asset: { manufacturer: "Philips", model: "DreamStation 2", serialNumber: "S1" },
        recall: {
          manufacturer: "Philips",
          modelMatch: "DreamStation",
          serialMatch: null,
        },
      }),
    ).toBe(false);
  });
});

describe("recallMatchesAsset — serial range", () => {
  const baseRecall = {
    manufacturer: "Philips",
    modelMatch: null,
    serialMatch: { kind: "range" as const, from: "S1000", to: "S2000" },
  };
  const baseAsset = { manufacturer: "Philips", model: "DreamStation" };

  it("matches inclusive lower bound", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "S1000" },
        recall: baseRecall,
      }),
    ).toBe(true);
  });

  it("matches inclusive upper bound", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "S2000" },
        recall: baseRecall,
      }),
    ).toBe(true);
  });

  it("matches an in-range serial", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "S1500" },
        recall: baseRecall,
      }),
    ).toBe(true);
  });

  it("rejects below the range", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "S0999" },
        recall: baseRecall,
      }),
    ).toBe(false);
  });

  it("rejects above the range", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "S2001" },
        recall: baseRecall,
      }),
    ).toBe(false);
  });

  it("normalizes case before comparing", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "s1500" },
        recall: baseRecall,
      }),
    ).toBe(true);
  });

  it("trims whitespace", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "  S1500  " },
        recall: baseRecall,
      }),
    ).toBe(true);
  });

  it("rejects when range is inverted (defensive — CSR typo)", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "S1500" },
        recall: {
          ...baseRecall,
          serialMatch: { kind: "range", from: "S2000", to: "S1000" },
        },
      }),
    ).toBe(false);
  });

  it("rejects when serial is empty string", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "" },
        recall: baseRecall,
      }),
    ).toBe(false);
  });
});

describe("recallMatchesAsset — serial list", () => {
  const baseAsset = { manufacturer: "ResMed", model: "AirSense 10" };

  it("matches when serial is in the list", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "R-123" },
        recall: {
          manufacturer: "ResMed",
          modelMatch: null,
          serialMatch: { kind: "list", serials: ["R-001", "R-123", "R-999"] },
        },
      }),
    ).toBe(true);
  });

  it("rejects when serial is not in the list", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "R-555" },
        recall: {
          manufacturer: "ResMed",
          modelMatch: null,
          serialMatch: { kind: "list", serials: ["R-001", "R-123"] },
        },
      }),
    ).toBe(false);
  });

  it("matches case-insensitively + whitespace-tolerantly", () => {
    expect(
      recallMatchesAsset({
        asset: { ...baseAsset, serialNumber: "r-123" },
        recall: {
          manufacturer: "ResMed",
          modelMatch: null,
          serialMatch: { kind: "list", serials: [" R-123 "] },
        },
      }),
    ).toBe(true);
  });
});

describe("recallMatchesAsset — combined criteria", () => {
  it("requires BOTH manufacturer AND model AND serial to match", () => {
    const recall = {
      manufacturer: "Philips",
      modelMatch: "DreamStation",
      serialMatch: { kind: "range" as const, from: "S1000", to: "S2000" },
    };
    // All three line up — match.
    expect(
      recallMatchesAsset({
        asset: {
          manufacturer: "Philips",
          model: "DreamStation",
          serialNumber: "S1500",
        },
        recall,
      }),
    ).toBe(true);
    // Different model — no match.
    expect(
      recallMatchesAsset({
        asset: {
          manufacturer: "Philips",
          model: "DreamStation 2",
          serialNumber: "S1500",
        },
        recall,
      }),
    ).toBe(false);
    // Serial out of range — no match.
    expect(
      recallMatchesAsset({
        asset: {
          manufacturer: "Philips",
          model: "DreamStation",
          serialNumber: "S9999",
        },
        recall,
      }),
    ).toBe(false);
  });
});
