import { describe, expect, it } from "vitest";

import { parseClassification } from "./ai-classify";

describe("parseClassification", () => {
  it("accepts a clean JSON payload", () => {
    const result = parseClassification(
      JSON.stringify({
        intent: "resupply",
        confidence: 0.92,
        summary: "Refill for 2 mask cushions and 1 filter.",
        flags: ["payer not in common list"],
      }),
    );
    expect(result).toEqual({
      intent: "resupply",
      confidence: 0.92,
      summary: "Refill for 2 mask cushions and 1 filter.",
      flags: ["payer not in common list"],
    });
  });

  it("tolerates a ```json fence wrapper", () => {
    const result = parseClassification(
      '```json\n{"intent":"refill","confidence":0.8,"summary":"Refill.","flags":[]}\n```',
    );
    expect(result?.intent).toBe("refill");
  });

  it("falls back to 'unknown' on an unrecognised intent", () => {
    const result = parseClassification(
      JSON.stringify({
        intent: "something_else",
        confidence: 0.5,
        summary: "x",
        flags: [],
      }),
    );
    expect(result?.intent).toBe("unknown");
  });

  it("clamps confidence to [0, 1]", () => {
    const high = parseClassification(
      JSON.stringify({
        intent: "refill",
        confidence: 2.5,
        summary: "x",
        flags: [],
      }),
    );
    expect(high?.confidence).toBe(1);

    const low = parseClassification(
      JSON.stringify({
        intent: "refill",
        confidence: -0.5,
        summary: "x",
        flags: [],
      }),
    );
    expect(low?.confidence).toBe(0);
  });

  it("defaults a missing/NaN confidence to 0", () => {
    const result = parseClassification(
      JSON.stringify({
        intent: "refill",
        summary: "x",
        flags: [],
      }),
    );
    expect(result?.confidence).toBe(0);
  });

  it("rejects a payload with an empty summary", () => {
    const result = parseClassification(
      JSON.stringify({
        intent: "refill",
        confidence: 0.9,
        summary: "",
        flags: [],
      }),
    );
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseClassification("not json")).toBeNull();
  });

  it("caps flags array at 10 entries and drops non-strings", () => {
    const result = parseClassification(
      JSON.stringify({
        intent: "resupply",
        confidence: 0.7,
        summary: "x",
        flags: [
          "a",
          "b",
          "c",
          "d",
          "e",
          "f",
          "g",
          "h",
          "i",
          "j",
          "k",
          "l",
          null,
          42,
          { x: 1 },
        ],
      }),
    );
    expect(result?.flags.length).toBe(10);
    expect(result?.flags.every((f) => typeof f === "string")).toBe(true);
  });

  it("truncates a long summary to 400 characters", () => {
    const long = "a".repeat(1000);
    const result = parseClassification(
      JSON.stringify({
        intent: "refill",
        confidence: 0.7,
        summary: long,
        flags: [],
      }),
    );
    expect(result?.summary.length).toBe(400);
  });
});
