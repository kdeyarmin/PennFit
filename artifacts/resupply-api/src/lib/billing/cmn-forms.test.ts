// Tests for the CMN/DIF form catalog + validators (Biller #29).

import { describe, it, expect } from "vitest";

import {
  validateCmnAnswers,
  formTypeForHcpcs,
  hcpcsRequiresCmn,
  isCmnFormType,
  CMN_FORMS,
} from "./cmn-forms";

describe("validateCmnAnswers", () => {
  it("flags every missing required key for a known form", () => {
    const v = validateCmnAnswers("cms_484", {});
    expect(v.unknownForm).toBe(false);
    expect(v.ready).toBe(false);
    expect(v.missing.sort()).toEqual(
      [...CMN_FORMS.cms_484!.requiredKeys].sort(),
    );
  });

  it("is ready when all required keys are answered (non-empty)", () => {
    const v = validateCmnAnswers("cms_484", {
      arterial_po2_or_sat: "55",
      test_date: "2026-05-01",
      test_condition: "rest",
      oxygen_flow_rate_lpm: 2,
      portable_oxygen: false, // booleans count as answered
    });
    expect(v).toEqual({ ready: true, missing: [], unknownForm: false });
  });

  it("treats empty / whitespace strings as unanswered", () => {
    const v = validateCmnAnswers("cms_848", {
      pain_location: "  ",
      pain_duration_months: 6,
      other_treatments_tried: "PT",
    });
    expect(v.ready).toBe(false);
    expect(v.missing).toContain("pain_location");
  });

  it("reports unknownForm for an unrecognized form type", () => {
    const v = validateCmnAnswers("nope", { a: 1 });
    expect(v).toEqual({ ready: false, missing: [], unknownForm: true });
  });
});

describe("formTypeForHcpcs / hcpcsRequiresCmn", () => {
  it("maps a covered HCPCS to its form (case-insensitive)", () => {
    expect(formTypeForHcpcs("e1390")).toBe("cms_484");
    expect(formTypeForHcpcs("E0650")).toBe("cms_846");
    expect(hcpcsRequiresCmn("E0779")).toBe(true);
  });

  it("returns null for an uncovered HCPCS", () => {
    expect(formTypeForHcpcs("E0601")).toBeNull(); // PAP — uses SWO, not a CMN
    expect(hcpcsRequiresCmn("A7030")).toBe(false);
  });
});

describe("isCmnFormType", () => {
  it("accepts catalog forms, rejects others", () => {
    expect(isCmnFormType("cms_484")).toBe(true);
    expect(isCmnFormType("dif_10126")).toBe(true);
    expect(isCmnFormType("bogus")).toBe(false);
    expect(isCmnFormType(42)).toBe(false);
  });
});
