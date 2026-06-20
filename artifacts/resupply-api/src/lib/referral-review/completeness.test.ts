import { describe, it, expect } from "vitest";

import { assessReferralCompleteness } from "./completeness";
import { assessPapQualification } from "./qualification";

const fullPatient = {
  firstName: "Jordan",
  lastName: "Rivera",
  dob: "1980-02-02",
};

describe("assessReferralCompleteness", () => {
  it("is complete when every element is present", () => {
    const c = assessReferralCompleteness({
      patient: fullPatient,
      insurance: { payerName: "Aetna", memberId: "W123" },
      diagnoses: [{ icd10: "G47.33" }],
      physician: { name: "Dr. Ada Lin", npi: "1234567890" },
      documents: [{ type: "physician_order" }, { type: "chart_note" }],
      qualification: assessPapQualification({ ahi: 22 }),
    });
    expect(c.complete).toBe(true);
    expect(c.outstandingCount).toBe(0);
    expect(c.providerRequests).toEqual([]);
    expect(c.items.every((i) => i.status === "present")).toBe(true);
  });

  it("flags every gap and produces a provider request for each", () => {
    const c = assessReferralCompleteness({
      patient: { firstName: "Jordan", lastName: null, dob: null },
      insurance: null,
      diagnoses: [],
      physician: { name: "Dr. Ada Lin", npi: null },
      documents: [{ type: "physician_order" }], // order present, no NPI; no chart note
      qualification: assessPapQualification({ ahi: null, rdi: null }),
    });
    expect(c.complete).toBe(false);
    const byKey = Object.fromEntries(c.items.map((i) => [i.key, i.status]));
    expect(byKey.demographics).toBe("missing");
    expect(byKey.insurance).toBe("missing");
    expect(byKey.diagnosis).toBe("missing");
    expect(byKey.sleep_study).toBe("missing"); // unknown verdict → missing
    expect(byKey.physician_order).toBe("attention"); // order but no NPI
    expect(byKey.face_to_face).toBe("attention");
    // One request line per non-present element.
    expect(c.providerRequests.length).toBe(c.outstandingCount);
    expect(c.providerRequests.join(" ")).toMatch(/NPI/);
  });

  it("marks a 5–14 study with no comorbidity as attention (not missing)", () => {
    const c = assessReferralCompleteness({
      patient: fullPatient,
      insurance: { payerName: "Aetna", memberId: "W123" },
      diagnoses: [{ icd10: "G47.33" }],
      physician: { name: "Dr. Ada Lin", npi: "1234567890" },
      documents: [{ type: "physician_order" }, { type: "chart_note" }],
      qualification: assessPapQualification({ ahi: 9, comorbidities: [] }),
    });
    const study = c.items.find((i) => i.key === "sleep_study")!;
    expect(study.status).toBe("attention");
    expect(study.request).toMatch(/comorbidity/i);
  });

  it("treats a missing physician_order section as missing", () => {
    const c = assessReferralCompleteness({
      patient: fullPatient,
      insurance: { payerName: "Aetna", memberId: "W123" },
      diagnoses: [{ icd10: "G47.33" }],
      physician: { name: null, npi: null },
      documents: [{ type: "demographics" }],
      qualification: assessPapQualification({ ahi: 22 }),
    });
    expect(c.items.find((i) => i.key === "physician_order")!.status).toBe(
      "missing",
    );
  });
});
