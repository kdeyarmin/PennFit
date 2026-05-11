// Pure-function tests for the SWO data validators + describer.
// PDF rendering is not exercised here — pdfkit's output is binary
// and well-tested upstream; we cover the validators (which gate the
// route's 422) and the small HCPCS→description helper.

import { describe, it, expect } from "vitest";

import {
  describeHcpcs,
  validateSwoInputs,
  type SwoInputs,
} from "./swo-pdf";

const baseInputs = (): SwoInputs => ({
  patient: {
    legalFirstName: "Jane",
    legalLastName: "Doe",
    dateOfBirth: "1965-04-12",
    address: null,
  },
  prescription: {
    itemSku: "MASK-NASAL-MED",
    hcpcsCode: "A7034",
    cadenceDays: 90,
    validFrom: "2026-01-01",
    validUntil: "2027-01-01",
    diagnosis: null,
    diagnosisIcd10: "G47.33",
  },
  provider: {
    legalName: "Dr. John Smith, MD",
    npi: "1234567893",
    practiceName: null,
    practiceAddress: null,
    phoneE164: null,
    faxE164: null,
  },
  generatedOn: new Date("2026-05-11T00:00:00Z"),
  supplierName: "PennPaps",
});

describe("validateSwoInputs", () => {
  it("accepts a complete input set", () => {
    expect(validateSwoInputs(baseInputs())).toEqual([]);
  });

  it("flags missing HCPCS code", () => {
    const inputs = baseInputs();
    inputs.prescription.hcpcsCode = null;
    const errors = validateSwoInputs(inputs);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("prescription.hcpcsCode");
  });

  it("flags missing patient legal name", () => {
    const inputs = baseInputs();
    inputs.patient.legalFirstName = "";
    const errors = validateSwoInputs(inputs);
    expect(errors.map((e) => e.field)).toContain("patient");
  });

  it("flags missing patient DOB", () => {
    const inputs = baseInputs();
    inputs.patient.dateOfBirth = "";
    expect(validateSwoInputs(inputs).map((e) => e.field)).toContain(
      "patient.dateOfBirth",
    );
  });

  it("flags malformed NPI", () => {
    const inputs = baseInputs();
    inputs.provider.npi = "12345"; // too short
    expect(validateSwoInputs(inputs).map((e) => e.field)).toContain(
      "provider.npi",
    );
  });

  it("flags missing provider name", () => {
    const inputs = baseInputs();
    inputs.provider.legalName = "";
    expect(validateSwoInputs(inputs).map((e) => e.field)).toContain(
      "provider.legalName",
    );
  });

  it("collects multiple errors at once (not short-circuit)", () => {
    const inputs = baseInputs();
    inputs.prescription.hcpcsCode = null;
    inputs.provider.npi = "";
    inputs.patient.dateOfBirth = "";
    const errors = validateSwoInputs(inputs);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("describeHcpcs", () => {
  it("maps known HCPCS codes to a human description", () => {
    expect(describeHcpcs("E0601", "CPAP-01")).toContain("CPAP device");
    expect(describeHcpcs("A7030", "MASK-FULL")).toContain("Full face mask");
    expect(describeHcpcs("A7038", "FILTER-DISP")).toContain("Disposable filter");
  });

  it("strips modifiers before lookup", () => {
    // A7030-KX should still map to "Full face mask" because the lookup
    // operates on the base code only.
    expect(describeHcpcs("A7030-KX", "MASK-FULL")).toContain("Full face mask");
  });

  it("falls back to the raw code when unknown", () => {
    const result = describeHcpcs("Z9999", "MYSTERY-SKU");
    expect(result).toContain("Z9999");
    expect(result).toContain("MYSTERY-SKU");
  });

  it("falls back to the SKU only when HCPCS is null", () => {
    expect(describeHcpcs(null, "ONLY-SKU")).toBe("ONLY-SKU");
  });

  it("is case-insensitive on the HCPCS code", () => {
    expect(describeHcpcs("e0601", "CPAP-01")).toContain("CPAP device");
  });
});
