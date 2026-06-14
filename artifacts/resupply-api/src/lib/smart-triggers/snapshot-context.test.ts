// Unit tests for the snapshot → EvaluationContext bridge. Only the
// pure payload parser is exercised here; the DB readers are thin
// PostgREST wrappers covered by the evaluator integration paths.

import { describe, it, expect } from "vitest";

import { readDeviceMaxPressure } from "./snapshot-context";

describe("readDeviceMaxPressure", () => {
  it("reads a numeric pressureMaxCmh2o from settings", () => {
    expect(
      readDeviceMaxPressure({ settings: { pressureMaxCmh2o: 20 } }),
    ).toBe(20);
  });

  it("coerces a stringified numeric (PostgREST numeric serialisation)", () => {
    expect(
      readDeviceMaxPressure({ settings: { pressureMaxCmh2o: "18.5" } }),
    ).toBe(18.5);
  });

  it("returns null when settings or the field is missing", () => {
    expect(readDeviceMaxPressure({})).toBeNull();
    expect(readDeviceMaxPressure({ settings: null })).toBeNull();
    expect(readDeviceMaxPressure({ settings: {} })).toBeNull();
    expect(
      readDeviceMaxPressure({ settings: { pressureMaxCmh2o: null } }),
    ).toBeNull();
  });

  it("rejects non-positive or non-finite values", () => {
    expect(
      readDeviceMaxPressure({ settings: { pressureMaxCmh2o: 0 } }),
    ).toBeNull();
    expect(
      readDeviceMaxPressure({ settings: { pressureMaxCmh2o: -5 } }),
    ).toBeNull();
    expect(
      readDeviceMaxPressure({ settings: { pressureMaxCmh2o: "abc" } }),
    ).toBeNull();
  });

  it("tolerates non-object payloads", () => {
    expect(readDeviceMaxPressure(null)).toBeNull();
    expect(readDeviceMaxPressure(undefined)).toBeNull();
    expect(readDeviceMaxPressure("nope")).toBeNull();
    expect(readDeviceMaxPressure(42)).toBeNull();
  });
});
