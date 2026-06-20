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

  it("models RAD (L33800): E0471 covers central apnea / COPD but NOT OSA", () => {
    // Mirrors the 0409 seed intent: E0471 (BiPAP-ST) is covered for the
    // RAD categories but never for obstructive sleep apnea (G47.33).
    const rad: CoverageDiagnosisRow[] = [
      { hcpcs_code: "E0471", icd10_code: "G4731", policy: "LCD L33800" },
      { hcpcs_code: "E0471", icd10_code: "E662", policy: "LCD L33800" },
      { hcpcs_code: "E0471", icd10_code: "J44", policy: "LCD L33800" },
    ];
    // Primary central sleep apnea → covered.
    expect(evaluateCoverageDiagnosis("E0471", ["G47.31"], rad).covered).toBe(
      true,
    );
    // Severe COPD J44.9 matches the 'J44' category prefix → covered.
    expect(evaluateCoverageDiagnosis("E0471", ["J44.9"], rad).covered).toBe(
      true,
    );
    // Obstructive sleep apnea is NOT a RAD indication for E0471 → warns.
    const osa = evaluateCoverageDiagnosis("E0471", ["G47.33"], rad);
    expect(osa.hasRules).toBe(true);
    expect(osa.covered).toBe(false);
  });
});
