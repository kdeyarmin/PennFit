import { describe, expect, it } from "vitest";

import { renderGfePdf, DEFAULT_GFE_DISCLAIMER } from "./gfe-pdf";

describe("renderGfePdf", () => {
  it("renders a PDF with the right total + non-empty body", async () => {
    const r = await renderGfePdf({
      recipientName: "Jane Doe",
      recipientEmail: "jane@example.com",
      items: [
        {
          description: "CPAP machine",
          hcpcsCode: "E0601",
          quantity: 1,
          unitPriceCents: 89500,
        },
        {
          description: "Nasal mask",
          hcpcsCode: "A7034",
          quantity: 1,
          unitPriceCents: 9499,
        },
      ],
      disclaimerText: DEFAULT_GFE_DISCLAIMER,
      dmeOrganization: {
        legalName: "PennPaps Inc",
        npi: "1234567893",
        addressLine1: "100 Main St",
        city: "State College",
        state: "PA",
        zip: "16801",
        phoneE164: "+18144710627",
        billingEmail: "billing@pennpaps.com",
      },
    });
    expect(r.pdf.length).toBeGreaterThan(1000);
    expect(r.totalCents).toBe(89500 + 9499);
    // PDF files start with the magic header %PDF.
    expect(r.pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("sums line totals correctly across multiple quantities", async () => {
    const r = await renderGfePdf({
      recipientName: "X",
      recipientEmail: "x@example.com",
      items: [
        {
          description: "Filter",
          hcpcsCode: "A7038",
          quantity: 3,
          unitPriceCents: 1599,
        },
      ],
      disclaimerText: DEFAULT_GFE_DISCLAIMER,
      dmeOrganization: {
        legalName: "X",
        npi: "0000000000",
        addressLine1: "X",
        city: "X",
        state: "PA",
        zip: "00000",
        phoneE164: "+10000000000",
        billingEmail: "x@x.com",
      },
    });
    expect(r.totalCents).toBe(1599 * 3);
  });
});
