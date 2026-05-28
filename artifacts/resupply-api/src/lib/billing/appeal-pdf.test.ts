// Tests for the appeal letter PDF generator.
//
// PDFKit emits FlateDecode-compressed streams, so we can't text-grep
// the buffer for rendered strings. We assert the structural contract:
//   * Returns a non-empty PDF buffer with the %PDF- header
//   * Renders with claimNumber=null and denialReason=null without throwing
//     (the route surfaces those for not-yet-assigned / missing-eob cases)
//   * Renders with payerAddressLines without throwing
//   * Renders with a multi-line letterBody without throwing

import { describe, it, expect } from "vitest";

import { renderAppealPdf } from "./appeal-pdf";

const ORG = {
  legalName: "PennPaps Inc",
  addressLine1: "1 Penn Plaza",
  city: "Philadelphia",
  state: "PA",
  zip: "19103",
  phoneE164: "+18001234567",
  billingEmail: "billing@pennpaps.com",
};

const BASE = {
  payerName: "Acme Insurance",
  claimNumber: "CLM-12345",
  patientName: "Alice Patient",
  patientMemberId: "MEM-ABC",
  dateOfService: "2026-04-01",
  denialReason: "Missing prior auth",
  letterBody: "Please reconsider this claim. Documentation attached.",
  signerName: "Billing Manager",
  signerTitle: "Billing Lead",
  dmeOrganization: ORG,
};

describe("renderAppealPdf", () => {
  it("renders a non-empty PDF with the %PDF- header", async () => {
    const pdf = await renderAppealPdf(BASE);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders without throwing when claimNumber is null", async () => {
    const pdf = await renderAppealPdf({ ...BASE, claimNumber: null });
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("renders without throwing when denialReason is null", async () => {
    const pdf = await renderAppealPdf({ ...BASE, denialReason: null });
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("renders payerAddressLines without throwing", async () => {
    const pdf = await renderAppealPdf({
      ...BASE,
      payerAddressLines: ["PO Box 12345", "Boston, MA 02101"],
    });
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("handles a long, multi-paragraph letterBody", async () => {
    const longBody =
      "Para 1. " + "x ".repeat(400) + "\n\nPara 2. " + "y ".repeat(400);
    const pdf = await renderAppealPdf({ ...BASE, letterBody: longBody });
    expect(pdf.length).toBeGreaterThan(0);
  });
});
