import { describe, it, expect } from "vitest";

import type { ReferralExtraction } from "./extract";
import {
  assembleReferralReport,
  renderReferralReviewReport,
} from "./report-pdf";

function extraction(
  over: Partial<ReferralExtraction> = {},
): ReferralExtraction {
  return {
    patient: {
      firstName: "Jane",
      lastName: "Doe",
      dob: "1960-02-03",
      phone: "+14155551212",
      email: null,
      address: null,
    },
    insurance: {
      payerName: "Aetna",
      planName: null,
      memberId: "W1",
      groupNumber: null,
      policyholderName: null,
      policyholderRelationship: null,
    },
    secondaryInsurance: null,
    order: [{ description: "CPAP device", hcpcs: "E0601" }],
    diagnoses: [{ icd10: "G47.33", description: "Obstructive sleep apnea" }],
    recommendedTherapy: "CPAP",
    comorbidities: [],
    sleepStudy: {
      studyDate: "2026-04-12",
      studyType: "home sleep test",
      ahi: 22,
      rdi: null,
      odi: null,
      totalSleepMinutes: 400,
      interpretingPhysician: null,
    },
    physician: {
      name: "Dr. House",
      npi: "1234567890",
      phone: null,
      fax: null,
      clinic: null,
    },
    documents: [
      { type: "physician_order", pageStart: 1, pageEnd: 1, title: "Order" },
      { type: "chart_note", pageStart: 2, pageEnd: 2, title: "Note" },
    ],
    summary: "New CPAP setup.",
    confidence: {
      patient: "high",
      insurance: "high",
      order: "high",
      sleepStudy: "high",
    },
    ...over,
  };
}

describe("assembleReferralReport", () => {
  it("computes a qualifying verdict and a complete checklist", () => {
    const { qualification, completeness } =
      assembleReferralReport(extraction());
    expect(qualification.verdict).toBe("qualifies");
    expect(completeness.complete).toBe(true);
  });

  it("flags an incomplete referral with provider requests", () => {
    const { completeness } = assembleReferralReport(
      extraction({
        insurance: null,
        diagnoses: [],
        sleepStudy: null,
      }),
    );
    expect(completeness.complete).toBe(false);
    expect(completeness.providerRequests.length).toBeGreaterThan(0);
  });
});

describe("renderReferralReviewReport", () => {
  it("produces a non-empty PDF buffer", async () => {
    const pdf = await renderReferralReviewReport({
      extraction: extraction(),
      supplierName: "Penn Home Medical Supply",
      generatedOn: new Date("2026-06-20T00:00:00Z"),
    });
    expect(pdf.byteLength).toBeGreaterThan(800);
    // PDF magic header.
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders without throwing for a sparse extraction", async () => {
    const pdf = await renderReferralReviewReport({
      extraction: extraction({
        diagnoses: [],
        order: [],
        sleepStudy: null,
        recommendedTherapy: null,
        summary: null,
      }),
      supplierName: "X",
    });
    expect(pdf.byteLength).toBeGreaterThan(500);
  });
});
