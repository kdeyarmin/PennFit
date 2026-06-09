import { describe, expect, it } from "vitest";

import { canRenderCmn, renderCmnPdf, type CmnPdfInput } from "./cmn-pdf";

function fixture(overrides: Partial<CmnPdfInput> = {}): CmnPdfInput {
  return {
    formType: "cms_484",
    hcpcsCode: "E1390",
    status: "completed",
    answers: {
      arterial_po2_or_sat: "87%",
      test_date: "2026-05-01",
      test_condition: "rest",
      oxygen_flow_rate_lpm: 2,
      portable_oxygen: true,
    },
    physicianName: "Dr. Alex Rivera",
    physicianNpi: "1700987654",
    initialDate: "2026-05-02",
    recertDate: null,
    lengthOfNeedMonths: 99,
    patient: {
      legalFirstName: "Jane",
      legalLastName: "Doe",
      dateOfBirth: "1955-03-04",
      address: { line1: "200 Elm St", city: "Altoona", state: "PA", zip: "16601" },
    },
    supplierName: "PennPaps Inc",
    generatedOn: new Date(Date.UTC(2026, 5, 9)),
    ...overrides,
  };
}

describe("canRenderCmn", () => {
  it("accepts catalog form types and rejects unknown ones", () => {
    expect(canRenderCmn("cms_484")).toBe(true);
    expect(canRenderCmn("cms_846")).toBe(true);
    expect(canRenderCmn("not_a_form")).toBe(false);
  });
});

describe("renderCmnPdf", () => {
  it("renders a non-empty PDF buffer for a completed CMS-484", async () => {
    const pdf = await renderCmnPdf(fixture());
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(800);
    // PDF magic header.
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders even when answers are missing (blank lines for the clinician)", async () => {
    const pdf = await renderCmnPdf(fixture({ answers: null, status: "draft" }));
    expect(pdf.length).toBeGreaterThan(800);
  });

  it("throws on an unknown form type", async () => {
    await expect(renderCmnPdf(fixture({ formType: "nope" }))).rejects.toThrow(
      /unknown form type/,
    );
  });

  it("handles a null physician + null address without throwing", async () => {
    const pdf = await renderCmnPdf(
      fixture({
        physicianName: null,
        physicianNpi: null,
        patient: {
          legalFirstName: "Jane",
          legalLastName: "Doe",
          dateOfBirth: "1955-03-04",
          address: null,
        },
      }),
    );
    expect(pdf.length).toBeGreaterThan(800);
  });
});
