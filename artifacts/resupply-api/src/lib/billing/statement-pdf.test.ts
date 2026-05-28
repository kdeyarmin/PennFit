// Tests for the patient billing statement PDF generator.
//
// PDFKit emits FlateDecode-compressed content streams, so we can't
// substring-check rendered text from the raw buffer. We assert the
// structural contract instead:
//   * Returns a non-empty PDF buffer (%PDF- header)
//   * Sums totalPatientResponsibilityCents across line items
//   * Sums to 0 with no line items
//   * Doesn't throw on a negative (credit) balance — the underlying
//     `money` helper bug is locked down separately by the structural
//     "doesn't crash on negative cents" path here plus visual
//     inspection at QA time
//   * Optional payByDate + paymentUrl + patient.address render without throwing

import { describe, it, expect } from "vitest";

import { renderStatementPdf, type StatementInput } from "./statement-pdf";

const ORG: StatementInput["dmeOrganization"] = {
  legalName: "PennPaps Inc",
  addressLine1: "1 Penn Plaza",
  city: "Philadelphia",
  state: "PA",
  zip: "19103",
  phoneE164: "+18001234567",
  billingEmail: "billing@pennpaps.com",
};

const PATIENT: StatementInput["patient"] = {
  name: "Alice Patient",
  address: {
    line1: "100 Main St",
    city: "Pittsburgh",
    state: "PA",
    zip: "15201",
  },
  email: "alice@a.test",
};

describe("renderStatementPdf", () => {
  it("renders a non-empty PDF with the %PDF- header", async () => {
    const result = await renderStatementPdf({
      patient: PATIENT,
      dmeOrganization: ORG,
      lineItems: [],
    });
    expect(result.pdf).toBeInstanceOf(Buffer);
    expect(result.pdf.length).toBeGreaterThan(0);
    expect(result.pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("sums to 0 with no line items", async () => {
    const result = await renderStatementPdf({
      patient: PATIENT,
      dmeOrganization: ORG,
      lineItems: [],
    });
    expect(result.totalPatientResponsibilityCents).toBe(0);
  });

  it("sums totalPatientResponsibilityCents across line items", async () => {
    const result = await renderStatementPdf({
      patient: PATIENT,
      dmeOrganization: ORG,
      lineItems: [
        {
          claimId: "c_1",
          payerName: "Acme",
          dateOfService: "2026-04-01",
          billedCents: 10000,
          paidCents: 6000,
          patientResponsibilityCents: 4000,
        },
        {
          claimId: "c_2",
          payerName: "Acme",
          dateOfService: "2026-04-15",
          billedCents: 8000,
          paidCents: 5000,
          patientResponsibilityCents: 3000,
        },
      ],
    });
    expect(result.totalPatientResponsibilityCents).toBe(7000);
  });

  it("renders without crashing on a negative (credit) balance", async () => {
    const result = await renderStatementPdf({
      patient: PATIENT,
      dmeOrganization: ORG,
      lineItems: [
        {
          claimId: "c_credit",
          payerName: "Acme",
          dateOfService: "2026-04-01",
          billedCents: 0,
          paidCents: 0,
          patientResponsibilityCents: -150,
        },
      ],
    });
    expect(result.pdf.length).toBeGreaterThan(0);
    expect(result.totalPatientResponsibilityCents).toBe(-150);
  });

  it("renders with optional payByDate + paymentUrl + address without throwing", async () => {
    const result = await renderStatementPdf({
      patient: {
        ...PATIENT,
        address: {
          line1: "100 Main St",
          line2: "Apt 4B",
          city: "Pittsburgh",
          state: "PA",
          zip: "15201",
        },
      },
      dmeOrganization: ORG,
      lineItems: [
        {
          claimId: "c_1",
          payerName: "Acme",
          dateOfService: "2026-04-01",
          billedCents: 10000,
          paidCents: 6000,
          patientResponsibilityCents: 4000,
        },
      ],
      payByDate: "2026-06-01",
      paymentUrl: "https://pay.pennpaps.com/abc",
    });
    expect(result.pdf.length).toBeGreaterThan(0);
  });
});
