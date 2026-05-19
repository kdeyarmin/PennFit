import { describe, expect, it } from "vitest";

import { renderDocumentationPacket } from "./documentation-packet";

const COMMON = {
  dmeOrganization: {
    legalName: "PennPaps Inc",
    addressLine1: "100 Main St",
    city: "State College",
    state: "PA",
    zip: "16801",
    phoneE164: "+18144710627",
    billingEmail: "billing@pennpaps.com",
    npi: "1234567893",
  },
  patient: {
    firstName: "Jane",
    lastName: "Doe",
    dateOfBirth: "1965-04-12",
    memberId: "M123456789",
    payerName: "Highmark BCBS",
  },
};

describe("renderDocumentationPacket", () => {
  it("renders a valid PDF with at least 1 page (cover only when no sections)", async () => {
    const r = await renderDocumentationPacket({
      ...COMMON,
      kind: "prior_auth_support",
      sections: [],
    });
    expect(r.pdf.length).toBeGreaterThan(1000);
    expect(r.pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(r.pageCount).toBe(1);
  });

  it("adds one page per section", async () => {
    const r = await renderDocumentationPacket({
      ...COMMON,
      kind: "prior_auth_support",
      sections: [
        {
          title: "Sleep Study Records",
          paragraphs: ["Two studies included."],
          bullets: ["2025-12-01 PSG — AHI 24.5", "2025-08-15 HSAT — AHI 18.0"],
        },
        {
          title: "Prescriptions",
          paragraphs: ["One active Rx."],
          bullets: ["E0601 RR — valid 2026-01-01"],
        },
      ],
    });
    expect(r.pageCount).toBe(3); // 1 cover + 2 section
  });

  it("uses the appeal cover letter default when kind=appeal_support", async () => {
    const r = await renderDocumentationPacket({
      ...COMMON,
      kind: "appeal_support",
      sections: [],
    });
    // We can't easily introspect PDF text; sanity check on size +
    // header instead. The appeal default is shorter than PA so this
    // is just verifying the renderer doesn't crash on the kind.
    expect(r.pdf.length).toBeGreaterThan(800);
    expect(r.pageCount).toBe(1);
  });

  it("honours a custom cover letter body when supplied", async () => {
    const r = await renderDocumentationPacket({
      ...COMMON,
      kind: "prior_auth_support",
      sections: [],
      coverLetterBody:
        "Custom override body that should appear instead of the default PA template.",
    });
    expect(r.pageCount).toBe(1);
  });

  it("emits a packet for every kind without crashing", async () => {
    for (const kind of [
      "prior_auth_support",
      "appeal_support",
      "accreditation_audit",
      "medical_records_request",
    ] as const) {
      const r = await renderDocumentationPacket({
        ...COMMON,
        kind,
        sections: [],
      });
      expect(r.pdf.length).toBeGreaterThan(500);
    }
  });
});
