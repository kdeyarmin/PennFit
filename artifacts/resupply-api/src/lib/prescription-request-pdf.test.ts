// Unit tests for prescription-request-pdf.ts. Coverage focus is on
// validation rules + the smoke check that render produces valid
// PDF bytes; visual layout is verified by an admin opening the
// preview URL.

import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";

import {
  renderPrescriptionRequest,
  validatePrescriptionRequestInputs,
  type PrescriptionRequestInputs,
} from "./prescription-request-pdf";

const SAMPLE: PrescriptionRequestInputs = {
  patient: {
    legalFirstName: "Jane",
    legalLastName: "Smith",
    dateOfBirth: "1970-01-15",
    address: {
      line1: "100 Main St",
      city: "Pittsburgh",
      state: "PA",
      postalCode: "15203",
    },
    phoneE164: "+14125550100",
  },
  provider: {
    legalName: "Brown, Alice MD",
    npi: "1234567890",
    practiceName: "Penn Sleep Medicine",
    faxE164: "+14125550199",
  },
  supplier: {
    practiceName: "PennPaps",
    faxE164: "+18005550100",
    email: "orders@pennpaps.com",
  },
  coverage: {
    payerName: "Medicare Part B (Noridian)",
    memberId: "1EG4TE5MK72",
    planName: null,
    rank: "primary",
    isMedicare: true,
  },
  hcpcsLines: [
    { hcpcs: "E0601", description: "CPAP device", quantity: 1 },
    {
      hcpcs: "A7034",
      description: "Nasal mask",
      quantity: 1,
      cadenceDays: 90,
      modifiers: ["NU"],
    },
    {
      hcpcs: "A7038",
      description: "Disposable filter",
      quantity: 2,
      cadenceDays: 30,
    },
  ],
  icd10Codes: ["G47.33"],
  settings: {
    deviceClass: "auto_cpap",
    pressureMinCmh2o: 6,
    pressureMaxCmh2o: 16,
    rampMinutes: 30,
    rampStartCmh2o: 4,
    humidifierSetting: 3,
    heatedTube: true,
  },
  lengthOfNeedMonths: 99,
  clinicalNotes: null,
  generatedOn: new Date("2026-05-22T10:00:00Z"),
};

describe("validatePrescriptionRequestInputs", () => {
  it("accepts a complete input set", () => {
    const result = validatePrescriptionRequestInputs(SAMPLE);
    expect(result.ok).toBe(true);
  });

  it("rejects when patient name is missing", () => {
    const result = validatePrescriptionRequestInputs({
      ...SAMPLE,
      patient: { ...SAMPLE.patient, legalLastName: "" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("patient.legalLastName");
  });

  it("rejects a malformed NPI", () => {
    const result = validatePrescriptionRequestInputs({
      ...SAMPLE,
      provider: { ...SAMPLE.provider, npi: "123" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("provider.npi");
  });

  it("rejects an empty equipment list", () => {
    const result = validatePrescriptionRequestInputs({
      ...SAMPLE,
      hcpcsLines: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("hcpcsLines");
  });

  it("rejects empty ICD-10 list", () => {
    const result = validatePrescriptionRequestInputs({
      ...SAMPLE,
      icd10Codes: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("icd10Codes");
  });

  it("rejects an out-of-range length of need", () => {
    const result = validatePrescriptionRequestInputs({
      ...SAMPLE,
      lengthOfNeedMonths: 200,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("lengthOfNeedMonths");
  });

  it("rejects missing supplier fax", () => {
    const result = validatePrescriptionRequestInputs({
      ...SAMPLE,
      supplier: { ...SAMPLE.supplier, faxE164: "" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("supplier.faxE164");
  });
});

async function renderToBytes(
  inputs: PrescriptionRequestInputs,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ margin: 72, size: "LETTER" });
  doc.on("data", (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  renderPrescriptionRequest(doc, inputs);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

describe("renderPrescriptionRequest", () => {
  it("produces valid PDF bytes (header + EOF)", async () => {
    const pdf = await renderToBytes(SAMPLE);
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.subarray(-6).toString("ascii")).toContain("%%EOF");
  });

  it("produces a noticeably larger PDF when more equipment lines + a settings block are present", async () => {
    const minimalPdf = await renderToBytes({
      ...SAMPLE,
      hcpcsLines: [SAMPLE.hcpcsLines[0]!],
      icd10Codes: ["G47.33"],
      settings: null,
    });
    const fullPdf = await renderToBytes(SAMPLE);
    // pdfkit deflates content streams so we don't grep for strings,
    // but a packet with 3 equipment rows + a settings block is
    // demonstrably bigger than one with one row + no settings.
    expect(fullPdf.length).toBeGreaterThan(minimalPdf.length);
  });

  it("renders bipap_st with a backup-rate settings block without throwing", async () => {
    const pdf = await renderToBytes({
      ...SAMPLE,
      settings: {
        deviceClass: "bipap_st",
        ipapCmh2o: 14,
        epapCmh2o: 8,
        backupRateBpm: 10,
        humidifierSetting: 2,
      },
    });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders without a settings block (mask-only refill)", async () => {
    const pdf = await renderToBytes({ ...SAMPLE, settings: null });
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders a long equipment list across a page break", async () => {
    const manyLines = Array.from({ length: 25 }, (_, i) => ({
      hcpcs: `A70${(i + 30).toString().padStart(2, "0")}`,
      description: `Accessory ${i + 1}`,
      quantity: 1,
      cadenceDays: 30,
    }));
    const pdf = await renderToBytes({
      ...SAMPLE,
      hcpcsLines: manyLines,
    });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it("renders a packet with clinical notes set", async () => {
    const pdf = await renderToBytes({
      ...SAMPLE,
      clinicalNotes:
        "Patient reports increased congestion — consider humidifier step up.",
    });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders without an insurance block when coverage is null", async () => {
    const pdf = await renderToBytes({ ...SAMPLE, coverage: null });
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders a commercial (non-Medicare) coverage block", async () => {
    const pdf = await renderToBytes({
      ...SAMPLE,
      coverage: {
        payerName: "UnitedHealthcare",
        memberId: "987654321",
        planName: "Choice Plus",
        rank: "primary",
        isMedicare: false,
      },
    });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders the PAP supporting-documentation note for a device order", async () => {
    // E0601 present + a settings block → PAP note path exercised.
    const pdf = await renderToBytes(SAMPLE);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // A mask-only refill (no device code, no settings) skips the note.
    const maskOnly = await renderToBytes({
      ...SAMPLE,
      hcpcsLines: [
        { hcpcs: "A7032", description: "Mask cushion", quantity: 1 },
      ],
      settings: null,
    });
    expect(maskOnly.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
