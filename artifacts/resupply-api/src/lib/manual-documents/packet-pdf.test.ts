import { describe, it, expect } from "vitest";

import {
  renderManualDocumentPacketPdf,
  type ManualDocumentPacketPdfInput,
} from "./packet-pdf";
import type { ManualDocumentPdfInput } from "./pdf";

function member(
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
    generatedOn: new Date("2026-06-10T00:00:00.000Z"),
    ...over,
  };
}

function input(
  over: Partial<ManualDocumentPacketPdfInput> = {},
): ManualDocumentPacketPdfInput {
  return {
    title: "Rivera intake packet",
    recipient: {
      name: "Dr. Pat Lee",
      address: null,
      email: "office@example.com",
      fax: "+12155551212",
    },
    documents: [
      member(),
      member({
        documentType: "delivery_ticket",
        title: "Delivery Ticket",
        fields: {
          patient_name: "Jordan Rivera",
          items_delivered: "E0601 CPAP, A7034 nasal mask",
        },
      }),
    ],
    includeCoverSheet: true,
    supplierName: "PennPaps",
    generatedOn: new Date("2026-06-10T00:00:00.000Z"),
    ...over,
  };
}

/** Count page objects in the (uncompressed-xref) PDFKit output. */
function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
}

describe("renderManualDocumentPacketPdf", () => {
  it("renders cover sheet + one page per document", async () => {
    const pdf = await renderManualDocumentPacketPdf(input());
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Cover sheet + 2 single-page documents.
    expect(pageCount(pdf)).toBe(3);
  });

  it("omits the cover sheet when includeCoverSheet=false", async () => {
    const pdf = await renderManualDocumentPacketPdf(
      input({ includeCoverSheet: false }),
    );
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(2);
  });

  it("renders a single non-PHI document without the banner path", async () => {
    const pdf = await renderManualDocumentPacketPdf(
      input({
        documents: [
          member({
            documentType: "cover_letter",
            title: "Fax cover",
            fields: { attention: "Records dept" },
            body: null,
          }),
        ],
      }),
    );
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(2);
  });

  it("rejects an empty packet", async () => {
    await expect(
      renderManualDocumentPacketPdf(input({ documents: [] })),
    ).rejects.toThrow(/empty packet/i);
  });
});
