// Unit tests for the referral-packet PDF splitter.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";

import { buildSectionFilename, splitPdfPages } from "./split-pdf";

/** Build an n-page PDF fixture in-memory. */
async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`page ${i + 1}`, { x: 20, y: 100 });
  }
  return Buffer.from(await doc.save());
}

async function pageCountOf(bytes: Buffer): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe("splitPdfPages", () => {
  it("splits a packet into the requested ranges", async () => {
    const source = await makePdf(6);
    const parts = await splitPdfPages(source, [
      { pageStart: 1, pageEnd: 1 },
      { pageStart: 2, pageEnd: 2 },
      { pageStart: 3, pageEnd: 6 },
    ]);
    expect(parts).toHaveLength(3);
    expect(await pageCountOf(parts[0]!)).toBe(1);
    expect(await pageCountOf(parts[1]!)).toBe(1);
    expect(await pageCountOf(parts[2]!)).toBe(4);
  });

  it("clamps a range that runs past the end of the document", async () => {
    const source = await makePdf(3);
    const [part] = await splitPdfPages(source, [{ pageStart: 2, pageEnd: 9 }]);
    expect(await pageCountOf(part!)).toBe(2); // pages 2-3
  });

  it("falls back to the whole document for a fully out-of-range request", async () => {
    const source = await makePdf(2);
    const [part] = await splitPdfPages(source, [{ pageStart: 5, pageEnd: 7 }]);
    expect(await pageCountOf(part!)).toBe(2);
  });

  it("throws on corrupt source bytes", async () => {
    await expect(
      splitPdfPages(Buffer.from("not a pdf"), [{ pageStart: 1, pageEnd: 1 }]),
    ).rejects.toThrow();
  });
});

describe("buildSectionFilename", () => {
  it("builds 'Label - Name.pdf'", () => {
    expect(buildSectionFilename("Sleep Study", "Jane Doe")).toBe(
      "Sleep Study - Jane Doe.pdf",
    );
  });

  it("strips hostile characters and collapses whitespace", () => {
    expect(buildSectionFilename('Order: "CPAP"\\rx', "Jane <Doe>/..")).toBe(
      "Order CPAP rx - Jane Doe ...pdf",
    );
  });

  it("falls back when parts are blank", () => {
    expect(buildSectionFilename("", "  ")).toBe(
      "Referral document - Patient.pdf",
    );
  });
});
