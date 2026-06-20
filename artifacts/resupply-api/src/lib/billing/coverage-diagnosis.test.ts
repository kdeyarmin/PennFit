import { describe, it, expect } from "vitest";

import {
  evaluateCoverageDiagnosis,
  normalizeIcd10,
  type CoverageDiagnosisRow,
} from "./coverage-diagnosis";

const PAP_RULES: CoverageDiagnosisRow[] = [
  { hcpcs_code: "E0601", icd10_code: "G4733", policy: "LCD L33718" },
  { hcpcs_code: "A7032", icd10_code: "G4733", policy: "LCD L33718" },
];

describe("normalizeIcd10", () => {
  it("uppercases and strips dots/whitespace", () => {
    expect(normalizeIcd10("g47.33")).toBe("G4733");
    expect(normalizeIcd10("  G47.33 ")).toBe("G4733");
    expect(normalizeIcd10(null)).toBe("");
    expect(normalizeIcd10(undefined)).toBe("");
    expect(normalizeIcd10("")).toBe("");
  });
});

describe("evaluateCoverageDiagnosis", () => {
  it("renders no opinion when the HCPCS has no catalogued rules", () => {
    const out = evaluateCoverageDiagnosis("E0562", ["G47.33"], PAP_RULES);
    expect(out.hasRules).toBe(false);
    expect(out.covered).toBe(false);
    expect(out.policies).toEqual([]);
  });

  it("covers an exact diagnosis match (dotted input)", () => {
    const out = evaluateCoverageDiagnosis("E0601", ["G47.33"], PAP_RULES);
    expect(out.hasRules).toBe(true);
    expect(out.covered).toBe(true);
    expect(out.policies).toEqual(["LCD L33718"]);
  });

  it("is HCPCS-case-insensitive and dot-insensitive", () => {
    const out = evaluateCoverageDiagnosis("e0601", ["g4733"], PAP_RULES);
    expect(out.covered).toBe(true);
  });

  it("flags an unsupported diagnosis for a catalogued HCPCS", () => {
    // R06.83 (snoring) does not support a PAP device.
    const out = evaluateCoverageDiagnosis("E0601", ["R06.83"], PAP_RULES);
    expect(out.hasRules).toBe(true);
    expect(out.covered).toBe(false);
  });

  it("flags when there is no diagnosis at all", () => {
    const out = evaluateCoverageDiagnosis("E0601", [], PAP_RULES);
    expect(out.hasRules).toBe(true);
    expect(out.covered).toBe(false);
  });

  it("covers a more-specific claim code under a covered category", () => {
    const rules: CoverageDiagnosisRow[] = [
      { hcpcs_code: "E0601", icd10_code: "G473", policy: "LCD L33718" },
    ];
    expect(evaluateCoverageDiagnosis("E0601", ["G47.33"], rules).covered).toBe(
      true,
    );
  });

  it("does NOT cover a less-specific claim code than the covered code", () => {
    // covered 'G4733' must not be satisfied by a vaguer 'G473'.
    expect(
      evaluateCoverageDiagnosis("E0601", ["G47.3"], PAP_RULES).covered,
    ).toBe(false);
  });

  it("covers when ANY of several diagnoses matches", () => {
    const out = evaluateCoverageDiagnosis(
      "A7032",
      ["E66.9", "G47.33"],
      PAP_RULES,
    );
    expect(out.covered).toBe(true);
  });

  it("de-dupes policies across multiple rules for the HCPCS", () => {
    const rules: CoverageDiagnosisRow[] = [
      { hcpcs_code: "E0601", icd10_code: "G4733", policy: "LCD L33718" },
      { hcpcs_code: "E0601", icd10_code: "G4730", policy: "LCD L33718" },
    ];
    const out = evaluateCoverageDiagnosis("E0601", ["R069"], rules);
    expect(out.policies).toEqual(["LCD L33718"]);
  });
});
