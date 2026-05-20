import { describe, expect, it } from "vitest";

import { inferDeviceClass } from "./link-equipment";

describe("inferDeviceClass", () => {
  it("defaults to cpap when therapyMode is null/empty", () => {
    expect(inferDeviceClass(null)).toBe("cpap");
    expect(inferDeviceClass("")).toBe("cpap");
    expect(inferDeviceClass(undefined)).toBe("cpap");
  });

  it("maps ResMed AutoSet to auto_cpap", () => {
    expect(inferDeviceClass("AutoSet")).toBe("auto_cpap");
  });

  it("maps APAP-Auto to auto_cpap", () => {
    expect(inferDeviceClass("APAP-Auto")).toBe("auto_cpap");
  });

  it("maps BiPAP to bipap", () => {
    expect(inferDeviceClass("BiPAP")).toBe("bipap");
  });

  it("maps Bilevel-ST to bipap", () => {
    expect(inferDeviceClass("Bilevel-ST")).toBe("bipap");
  });

  it("maps ASV / AVAPS distinctly", () => {
    expect(inferDeviceClass("ASV")).toBe("asv");
    expect(inferDeviceClass("AVAPS")).toBe("avaps");
  });

  it("falls back to cpap for unknown modes", () => {
    expect(inferDeviceClass("MysteryMode42")).toBe("cpap");
  });
});
