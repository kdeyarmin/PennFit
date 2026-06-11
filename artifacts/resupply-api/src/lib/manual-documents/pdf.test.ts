import { describe, it, expect } from "vitest";

import { renderManualDocumentPdf, type ManualDocumentPdfInput } from "./pdf";

function input(
  over: Partial<ManualDocumentPdfInput> = {},
): ManualDocumentPdfInput {
  return {
    documentType: "cmn",
    title: "Certificate of Medical Necessity",
    recipient: {
      name: "Dr. Pat Lee",
      address: "1 Main St, Phila, PA 19103",
      email: null,
      fax: "+12155551212",
    },
    fields: {
      patient_name: "Jordan Rivera",
      diagnosis: "G47.33 Obstructive sleep apnea",
      equipment: "E0601 CPAP",
    },
    body: "Patient requires CPAP for documented OSA.",
    supplierName: "PennPaps",
    generatedOn: new Date("2026-06-09T00:00:00.000Z"),
    ...over,
  };
}

describe("renderManualDocumentPdf", () => {
  it("renders a non-trivial PDF buffer", async () => {
    const pdf = await renderManualDocumentPdf(input());
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.byteLength).toBeGreaterThan(500);
    // PDF magic header.
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with empty fields and no recipient (free-form letter)", async () => {
    const pdf = await renderManualDocumentPdf(
      input({
        documentType: "other",
        title: "A letter",
        recipient: {},
        fields: {},
        body: "Hello there.",
      }),
    );
    expect(pdf.byteLength).toBeGreaterThan(300);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("tolerates a completely empty document", async () => {
    const pdf = await renderManualDocumentPdf(
      input({
        documentType: "cover_letter",
        title: "Fax cover",
        recipient: {},
        fields: null,
        body: null,
      }),
    );
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a short PHI document on exactly one page (no trailing blank from the footer)", async () => {
    const pdf = await renderManualDocumentPdf(input());
    const pages = (pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? [])
      .length;
    expect(pages).toBe(1);
  });
});
