import { describe, expect, it } from "vitest";

import { diffSettings } from "./diff-settings";

const base = {
  deviceModel: "AirSense 11",
  deviceSerial: "SN1",
  therapyMode: "AutoSet",
  pressureMinCmh2o: 6,
  pressureMaxCmh2o: 14,
  rampMinutes: 20,
  humidifierLevel: 4,
  maskType: "AirFit F30",
};

describe("diffSettings", () => {
  it("returns [] when both are null", () => {
    expect(diffSettings(null, null)).toEqual([]);
  });

  it("returns [] when one side is null", () => {
    expect(diffSettings(null, base)).toEqual([]);
    expect(diffSettings(base, null)).toEqual([]);
  });

  it("returns [] when nothing changed", () => {
    expect(diffSettings(base, { ...base })).toEqual([]);
  });

  it("detects pressure range changes", () => {
    const after = { ...base, pressureMaxCmh2o: 16 };
    const d = diffSettings(base, after);
    expect(d).toEqual([{ field: "pressureMaxCmh2o", before: 14, after: 16 }]);
  });

  it("detects mode + humidifier together", () => {
    const after = { ...base, therapyMode: "CPAP", humidifierLevel: 0 };
    const d = diffSettings(base, after);
    expect(d.map((c) => c.field).sort()).toEqual([
      "humidifierLevel",
      "therapyMode",
    ]);
  });
});
