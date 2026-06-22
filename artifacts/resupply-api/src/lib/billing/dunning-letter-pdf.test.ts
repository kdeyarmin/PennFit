import { describe, expect, it } from "vitest";

import { renderDunningLettersBatchPdf } from "./dunning-letter-pdf";

const company = {
  legalName: "Penn Home Medical Supply",
  addressLines: ["1 Main St", "Philadelphia, PA 19100"],
  phone: "+12155551212",
};

describe("renderDunningLettersBatchPdf", () => {
  it("throws on an empty batch", async () => {
    await expect(
      renderDunningLettersBatchPdf({
        company,
        letters: [],
        generatedOn: new Date("2026-06-22"),
      }),
    ).rejects.toThrow();
  });

  it("renders a PDF and reports the letter count", async () => {
    const { pdf, letterCount } = await renderDunningLettersBatchPdf({
      company,
      letters: [
        {
          patientName: "Jane Doe",
          addressLines: ["2 Oak Ave", "Philadelphia, PA 19101"],
          balanceCents: 12500,
        },
        {
          patientName: "John Roe",
          addressLines: [],
          balanceCents: 4000,
          payByDate: "2026-07-15",
        },
      ],
      generatedOn: new Date("2026-06-22"),
    });
    expect(letterCount).toBe(2);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);
  });
});
