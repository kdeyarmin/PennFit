import { describe, expect, it } from "vitest";

import { applyRequiredModifierBaseline } from "./claim-builder";

describe("applyRequiredModifierBaseline", () => {
  it("prepends the first required modifier when none are present", () => {
    expect(applyRequiredModifierBaseline([], ["KX"])).toEqual(["KX"]);
    expect(applyRequiredModifierBaseline(["RR"], ["KX"])).toEqual([
      "KX",
      "RR",
    ]);
  });

  it("is a no-op when at least one required modifier is already present", () => {
    expect(applyRequiredModifierBaseline(["KX", "RR"], ["KX"])).toEqual([
      "KX",
      "RR",
    ]);
  });

  it("matches case-insensitively when checking presence", () => {
    expect(applyRequiredModifierBaseline(["kx"], ["KX"])).toEqual(["kx"]);
  });

  it("treats any element of required[] as sufficient (KX or RR…)", () => {
    expect(
      applyRequiredModifierBaseline(["RR"], ["KX", "RR", "NU"]),
    ).toEqual(["RR"]);
    expect(applyRequiredModifierBaseline([], ["KX", "RR"])).toEqual(["KX"]);
  });

  it("is a no-op when required[] is empty", () => {
    expect(applyRequiredModifierBaseline(["RR"], [])).toEqual(["RR"]);
  });

  it("respects the 4-modifier EDI cap", () => {
    expect(
      applyRequiredModifierBaseline(["A1", "B2", "C3", "D4"], ["KX"]),
    ).toEqual(["A1", "B2", "C3", "D4"]);
    expect(
      applyRequiredModifierBaseline(["A1", "B2", "C3"], ["KX"]),
    ).toEqual(["KX", "A1", "B2", "C3"]);
  });
});
