import { describe, expect, it } from "vitest";

import { renderPaRequestPdf, type PaRequestInput } from "./pa-request-pdf";

const base: PaRequestInput = {
  generatedOn: new Date("2026-06-01T12:00:00Z"),
  payerDisplayName: "Highmark Blue Cross Blue Shield (Western PA)",
  payerPriorAuthFaxE164: "+18664887443",
  payerPriorAuthPhoneE164: "+18664887443",
  payerSubmissionMethod: "fax",
  payerTurnaroundBusinessDays: 7,
  supplierName: "PennPaps Inc",
  supplierNpi: "1234567893",
  supplierTaxId: "12-3456789",
  supplierAddress: {
    line1: "100 Main St",
    city: "State College",
    state: "PA",
    zip: "16801",
  },
  supplierPhoneE164: "+18144710627",
  patientLastName: "Doe",
  patientFirstName: "Jane",
  patientDateOfBirth: "1968-04-12",
  patientSex: "F",
  patientAddress: {
    line1: "9 Oak Ln",
    city: "Altoona",
    state: "PA",
    zip: "16601",
  },
  patientPhoneE164: "+18145551212",
  memberId: "ABC123456789",
  groupNumber: "GRP-77",
  planName: "Highmark PPO",
  orderingProviderName: "Smith, Robert MD",
  orderingProviderNpi: "1987654320",
  orderingProviderPhoneE164: "+18145559090",
  requestedLines: [
    {
      hcpcsCode: "E0601",
      description: "CPAP device",
      modifiers: ["KX", "RR"],
      quantity: 1,
      lengthOfNeedMonths: 99,
    },
    {
      hcpcsCode: "A7034",
      description: "Nasal mask interface",
      quantity: 1,
      lengthOfNeedMonths: 99,
    },
  ],
  diagnosisIcd10: "G47.33",
  faceToFaceDate: "2026-05-01",
  sleepStudy: {
    type: "hsat",
    date: "2026-05-10",
    ahi: 22,
    rdi: 24,
    facilityName: "Central PA Sleep Center",
  },
  prescribedPressure: "10 cmH2O",
  clinicalNotes: "Patient reports excessive daytime sleepiness; ESS 14.",
};

describe("renderPaRequestPdf", () => {
  it("renders a non-trivial PDF with the %PDF magic header", async () => {
    const buf = await renderPaRequestPdf(base);
    expect(buf.length).toBeGreaterThan(1500);
    expect(buf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("renders even when most clinical/optional fields are blank", async () => {
    const sparse: PaRequestInput = {
      generatedOn: new Date("2026-06-01T12:00:00Z"),
      payerDisplayName: "PA Health & Wellness",
      supplierName: "PennPaps Inc",
      patientLastName: "Roe",
      patientFirstName: "John",
      patientDateOfBirth: "1955-01-01",
      memberId: "0123456789",
      requestedLines: [
        { hcpcsCode: "E0470", description: "BiPAP device", quantity: 1 },
      ],
    };
    const buf = await renderPaRequestPdf(sparse);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("renders with no requested lines (draws empty ruled rows)", async () => {
    const buf = await renderPaRequestPdf({ ...base, requestedLines: [] });
    expect(buf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });
});
