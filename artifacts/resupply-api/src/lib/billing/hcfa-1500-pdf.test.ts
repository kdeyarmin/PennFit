// Tests for the CMS-1500 (HCFA-1500) PDF generator.
//
// Same posture as the other PDF tests: PDFKit emits compressed
// content streams so we can't text-grep. Structural assertions only:
//   * Returns a non-empty PDF buffer with the %PDF- header
//   * Renders the minimal-required input set without throwing
//   * Renders with optional payer mailing address + referring provider
//   * Renders with the full 6 service lines (max per page) without throwing
//   * Renders without throwing with 0 service lines (rare, but happens)

import { describe, it, expect } from "vitest";

import {
  renderHcfa1500Pdf,
  type Hcfa1500Input,
  type Hcfa1500ServiceLine,
  type PostalAddress,
} from "./hcfa-1500-pdf";

const ADDRESS: PostalAddress = {
  line1: "100 Main St",
  city: "Pittsburgh",
  state: "PA",
  zip: "15201",
};

const BILLING_ADDRESS: PostalAddress = {
  line1: "1 Penn Plaza",
  city: "Philadelphia",
  state: "PA",
  zip: "19103",
};

const SERVICE: Hcfa1500ServiceLine = {
  fromDate: "2026-04-01",
  toDate: "2026-04-01",
  placeOfService: "12",
  hcpcsCode: "A7034",
  modifiers: ["NU"],
  diagnosisPointer: "A",
  chargesCents: 12500,
  units: 1,
};

const BASE: Hcfa1500Input = {
  insuranceType: "medicare",
  insuredIdNumber: "1A2B3C4D5E",
  patientLastName: "Patient",
  patientFirstName: "Alice",
  patientDateOfBirth: "1965-04-12",
  patientSex: "F",
  insuredName: "Alice Patient",
  patientAddress: ADDRESS,
  relationship: "self",
  insuredAddress: ADDRESS,
  policyOrGroupNumber: "GRP-1",
  payerName: "Medicare Part B",
  diagnosisCodes: ["G47.33"],
  serviceLines: [SERVICE],
  taxId: "999999999",
  totalChargeCents: 12500,
  signatureOnFile: "SIGNATURE ON FILE",
  billingProviderName: "PennPaps Inc",
  billingProviderAddress: BILLING_ADDRESS,
  billingProviderNpi: "1234567890",
  billingProviderPhoneE164: "+18001234567",
};

describe("renderHcfa1500Pdf", () => {
  it("renders a non-empty PDF with the %PDF- header on minimal input", async () => {
    const pdf = await renderHcfa1500Pdf(BASE);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders with payerMailingAddress and referringProvider", async () => {
    const pdf = await renderHcfa1500Pdf({
      ...BASE,
      payerMailingAddress: {
        line1: "PO Box 12345",
        city: "Boston",
        state: "MA",
        zip: "02101",
      },
      referringProviderName: "Dr. Referring",
      referringProviderNpi: "0987654321",
      priorAuthNumber: "PA-998877",
    });
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("renders the maximum 6 service lines per page", async () => {
    const sixLines: Hcfa1500ServiceLine[] = Array.from(
      { length: 6 },
      (_, i) => ({
        ...SERVICE,
        hcpcsCode: `A703${i}`,
        chargesCents: 1000 * (i + 1),
      }),
    );
    const pdf = await renderHcfa1500Pdf({
      ...BASE,
      serviceLines: sixLines,
      totalChargeCents: 21000,
    });
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("renders with zero service lines without throwing", async () => {
    const pdf = await renderHcfa1500Pdf({
      ...BASE,
      serviceLines: [],
      totalChargeCents: 0,
    });
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("renders with multiple diagnosis codes (full 12)", async () => {
    const pdf = await renderHcfa1500Pdf({
      ...BASE,
      diagnosisCodes: [
        "G47.33",
        "G47.30",
        "I10",
        "E11.9",
        "Z79.4",
        "K21.9",
        "M54.5",
        "F41.1",
        "J45.20",
        "N39.0",
        "I25.10",
        "E78.5",
      ],
    });
    expect(pdf.length).toBeGreaterThan(0);
  });
});
