import { describe, expect, it } from "vitest";

import {
  purposeLabel,
  renderDisclosureAccountingPdf,
} from "./disclosure-accounting-pdf";

describe("purposeLabel", () => {
  it("returns a human label for every disclosure purpose", () => {
    expect(purposeLabel("public_health")).toBe("Public health activities");
    expect(purposeLabel("law_enforcement")).toBe("Law enforcement purposes");
    expect(purposeLabel("other")).toBe("Other");
  });
});

describe("renderDisclosureAccountingPdf", () => {
  const dme = {
    legalName: "PennPaps Inc.",
    addressLine1: "100 Main St",
    city: "Pittsburgh",
    state: "PA",
    zip: "15213",
    phoneE164: "+14125550100",
    billingEmail: "privacy@pennpaps.com",
  };

  it("renders a PDF buffer with the PDF magic header", async () => {
    const pdf = await renderDisclosureAccountingPdf({
      patientName: "Doe, John",
      patientDateOfBirth: "1960-04-12",
      windowStart: "2024-01-01",
      windowEnd: "2026-05-23",
      entries: [],
      dmeOrganization: dme,
      signerName: "Jane Privacy",
      signerTitle: "Privacy Officer",
    });
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.slice(0, 5).toString("utf8")).toBe("%PDF-");
  });

  it("handles entries that span more than one page without throwing", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e-${i}`,
      recipientName: `Recipient ${i}`,
      recipientAddress: `Addr ${i}`,
      purpose: "law_enforcement" as const,
      description: `Disclosure ${i}`,
      legalAuthority: `Subpoena #${i}`,
      disclosedAt: "2025-06-01T00:00:00Z",
    }));
    const pdf = await renderDisclosureAccountingPdf({
      patientName: "Doe, John",
      patientDateOfBirth: null,
      windowStart: null,
      windowEnd: "2026-05-23",
      entries,
      dmeOrganization: dme,
      signerName: "Jane Privacy",
      signerTitle: "Privacy Officer",
    });
    expect(pdf.slice(0, 5).toString("utf8")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1500);
  });
});
