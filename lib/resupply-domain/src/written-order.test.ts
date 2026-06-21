import { describe, it, expect } from "vitest";

import {
  isSwoComplete,
  validateSwoCompleteness,
  type SwoInputs,
} from "./written-order";

const baseInputs = (): SwoInputs => ({
  patient: {
    legalFirstName: "Jane",
    legalLastName: "Doe",
    dateOfBirth: "1965-04-12",
  },
  prescription: {
    hcpcsCode: "A7034",
  },
  provider: {
    legalName: "Dr. John Smith, MD",
    npi: "1234567893",
  },
});

describe("validateSwoCompleteness", () => {
  it("accepts a complete input set", () => {
    expect(validateSwoCompleteness(baseInputs())).toEqual([]);
    expect(isSwoComplete(baseInputs())).toBe(true);
  });

  it("flags missing HCPCS code", () => {
    const inputs = baseInputs();
    inputs.prescription.hcpcsCode = null;
    const errors = validateSwoCompleteness(inputs);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("prescription.hcpcsCode");
    expect(isSwoComplete(inputs)).toBe(false);
  });

  it("flags a missing first OR last name under the same field", () => {
    const noFirst = baseInputs();
    noFirst.patient.legalFirstName = "";
    expect(validateSwoCompleteness(noFirst).map((e) => e.field)).toContain(
      "patient",
    );

    const noLast = baseInputs();
    noLast.patient.legalLastName = "";
    expect(validateSwoCompleteness(noLast).map((e) => e.field)).toContain(
      "patient",
    );
  });

  it("flags missing patient DOB", () => {
    const inputs = baseInputs();
    inputs.patient.dateOfBirth = "";
    expect(validateSwoCompleteness(inputs).map((e) => e.field)).toContain(
      "patient.dateOfBirth",
    );
  });

  it("flags a malformed NPI (not exactly 10 digits)", () => {
    const short = baseInputs();
    short.provider.npi = "12345";
    expect(validateSwoCompleteness(short).map((e) => e.field)).toContain(
      "provider.npi",
    );

    const nonDigit = baseInputs();
    nonDigit.provider.npi = "12345678X0";
    expect(validateSwoCompleteness(nonDigit).map((e) => e.field)).toContain(
      "provider.npi",
    );

    const tooLong = baseInputs();
    tooLong.provider.npi = "12345678901";
    expect(validateSwoCompleteness(tooLong).map((e) => e.field)).toContain(
      "provider.npi",
    );
  });

  it("flags missing provider name", () => {
    const inputs = baseInputs();
    inputs.provider.legalName = "";
    expect(validateSwoCompleteness(inputs).map((e) => e.field)).toContain(
      "provider.legalName",
    );
  });

  it("collects multiple errors at once (not short-circuit)", () => {
    const inputs = baseInputs();
    inputs.prescription.hcpcsCode = null;
    inputs.provider.npi = "";
    inputs.patient.dateOfBirth = "";
    const errors = validateSwoCompleteness(inputs);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(isSwoComplete(inputs)).toBe(false);
  });
});
