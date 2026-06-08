import { describe, it, expect } from "vitest";

import {
  describeHcpcsFamily,
  dwoFormTitle,
  renderDwoPdf,
  validateDwoInput,
  type DwoPdfInput,
} from "./dwo-pdf";

function input(over: Partial<DwoPdfInput> = {}): DwoPdfInput {
  return {
    formType: "dwo",
    hcpcsFamily: "pap",
    signedOn: "2026-01-10",
    expiresOn: "2027-01-10",
    notes: "CPAP E0601 + supplies",
    patient: {
      legalFirstName: "Jordan",
      legalLastName: "Rivera",
      dateOfBirth: "1971-04-02",
      address: {
        line1: "1 Main St",
        city: "Phila",
        state: "PA",
        postalCode: "19103",
      },
    },
    provider: {
      legalName: "Dr. Pat Lee",
      npi: "1234567890",
      practiceName: "Sleep Health",
      phoneE164: "+12155551212",
      faxE164: null,
    },
    generatedOn: new Date("2026-02-01T00:00:00.000Z"),
    supplierName: "PennPaps",
    ...over,
  };
}

describe("dwoFormTitle / describeHcpcsFamily (pure)", () => {
  it("titles each form family", () => {
    expect(dwoFormTitle("dwo")).toBe("Detailed Written Order");
    expect(dwoFormTitle("cmn_484")).toContain("CMS-484");
    expect(dwoFormTitle("cmn_843")).toContain("CMS-843");
    expect(dwoFormTitle("swo")).toBe("Standard Written Order");
  });
  it("describes each HCPCS family", () => {
    expect(describeHcpcsFamily("oxygen")).toMatch(/oxygen/i);
    expect(describeHcpcsFamily("pap")).toMatch(/airway/i);
    expect(describeHcpcsFamily("other")).toMatch(/other/i);
  });
});

describe("validateDwoInput (pure)", () => {
  it("passes a complete input", () => {
    expect(validateDwoInput(input())).toEqual([]);
  });
  it("flags missing patient name + DOB", () => {
    const errs = validateDwoInput(
      input({
        patient: {
          legalFirstName: "",
          legalLastName: "",
          dateOfBirth: "",
          address: null,
        },
      }),
    );
    expect(errs.map((e) => e.field)).toEqual(
      expect.arrayContaining(["patient", "patient.dateOfBirth"]),
    );
  });
  it("flags a malformed provider NPI", () => {
    const errs = validateDwoInput(
      input({
        provider: {
          legalName: "Dr. X",
          npi: "12",
          practiceName: null,
          phoneE164: null,
          faxE164: null,
        },
      }),
    );
    expect(errs.some((e) => e.field === "provider.npi")).toBe(true);
  });
  it("accepts a null provider (unlinked order)", () => {
    expect(validateDwoInput(input({ provider: null }))).toEqual([]);
  });
});

describe("renderDwoPdf", () => {
  it("returns a non-empty PDF buffer", async () => {
    const buf = await renderDwoPdf(input());
    expect(buf.length).toBeGreaterThan(500);
    // PDF magic header.
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with no provider linked", async () => {
    const buf = await renderDwoPdf(input({ provider: null }));
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
