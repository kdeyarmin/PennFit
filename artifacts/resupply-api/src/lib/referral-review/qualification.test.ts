import { describe, it, expect } from "vitest";

import { assessPapQualification } from "./qualification";

describe("assessPapQualification", () => {
  it("qualifies on AHI >= 15 with no comorbidity needed", () => {
    const q = assessPapQualification({ ahi: 22, rdi: null, comorbidities: [] });
    expect(q.verdict).toBe("qualifies");
    expect(q.qualifyingValue).toBe(22);
    expect(q.metric).toBe("AHI");
    expect(q.summary).toContain("≥ 15");
  });

  it("uses the greater of AHI and RDI as the qualifying value", () => {
    const q = assessPapQualification({ ahi: 8, rdi: 17, comorbidities: [] });
    expect(q.qualifyingValue).toBe(17);
    expect(q.metric).toBe("RDI");
    expect(q.verdict).toBe("qualifies");
  });

  it("qualifies in the 5–14 band WITH a documented comorbidity", () => {
    const q = assessPapQualification({
      ahi: 9,
      rdi: null,
      comorbidities: ["hypertension"],
    });
    expect(q.verdict).toBe("qualifies_with_comorbidity");
    expect(q.hasDocumentedComorbidity).toBe(true);
    expect(q.details.join(" ")).toContain("hypertension");
  });

  it("is conditional in the 5–14 band with NO comorbidity", () => {
    const q = assessPapQualification({ ahi: 9, rdi: 6, comorbidities: [] });
    expect(q.verdict).toBe("conditional");
    expect(q.qualifyingValue).toBe(9);
    expect(q.summary).toContain("5–14");
    // It tells the operator what's needed.
    expect(q.details.join(" ")).toMatch(/comorbidity/i);
  });

  it("treats whitespace-only comorbidities as none", () => {
    const q = assessPapQualification({
      ahi: 10,
      rdi: null,
      comorbidities: ["  ", null, undefined],
    });
    expect(q.hasDocumentedComorbidity).toBe(false);
    expect(q.verdict).toBe("conditional");
  });

  it("does not qualify below AHI 5", () => {
    const q = assessPapQualification({ ahi: 3, rdi: 2, comorbidities: [] });
    expect(q.verdict).toBe("not_qualifying");
    expect(q.qualifyingValue).toBe(3);
  });

  it("is unknown when neither AHI nor RDI is present", () => {
    const q = assessPapQualification({
      ahi: null,
      rdi: null,
      comorbidities: ["hypertension"],
    });
    expect(q.verdict).toBe("unknown");
    expect(q.qualifyingValue).toBeNull();
    expect(q.metric).toBeNull();
  });

  it("floors the displayed index so it never crosses its own band label", () => {
    // 14.96 is below 15 → conditional; the shown number must read 14.9, not
    // a rounded "15" that would contradict the "(5–14)" band.
    const q = assessPapQualification({ ahi: 14.96 });
    expect(q.verdict).toBe("conditional");
    expect(q.summary).toContain("14.9");
    expect(q.summary).not.toContain("15");
  });

  it("treats the 15 boundary as qualifying and ignores non-finite values", () => {
    expect(assessPapQualification({ ahi: 15 }).verdict).toBe("qualifies");
    expect(
      assessPapQualification({ ahi: Number.NaN, rdi: 5 }).qualifyingValue,
    ).toBe(5);
  });
});
