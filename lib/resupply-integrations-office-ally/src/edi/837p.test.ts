import { describe, expect, it } from "vitest";

import {
  build837P,
  centsToMoney,
  digitsOnly,
  sanitizeElement,
  toCcyymmdd,
  type Claim837PInput,
} from "./837p";
import { allocateControlNumbers } from "./control-numbers";

const FIXED_BUILT_AT = Date.UTC(2026, 4, 19, 14, 37, 0); // 2026-05-19 14:37 UTC

function fixtureInput(overrides: Partial<Claim837PInput> = {}): Claim837PInput {
  const control = allocateControlNumbers({
    submittedAt: FIXED_BUILT_AT,
    sequence: 1,
  });
  return {
    submitter: {
      etin: "PENNPAPS01",
      organizationName: "PENNPAPS INC",
      contactName: "BILLING TEAM",
      contactPhoneE164: "+18144710627",
    },
    receiver: {
      interchangeId: "OFFCLY",
      organizationName: "OFFICE ALLY",
    },
    billingProvider: {
      organizationName: "PENNPAPS INC",
      npi: "1234567893",
      taxId: "123456789",
      address: {
        line1: "100 MAIN ST",
        city: "STATE COLLEGE",
        state: "PA",
        zip: "16801",
      },
    },
    claims: [
      {
        internalClaimId: "CLM-0001",
        totalBilledCents: 24999,
        placeOfServiceCode: "12",
        diagnosisCodes: ["G47.33"],
        priorAuthNumber: "PA-ABCD",
        subscriber: {
          firstName: "JANE",
          lastName: "DOE",
          dateOfBirth: "1965-04-12",
          gender: "F",
          memberId: "M123456789",
          address: {
            line1: "200 ELM ST",
            city: "ALTOONA",
            state: "PA",
            zip: "16601",
          },
          relationshipCode: "18",
        },
        payer: {
          organizationName: "HIGHMARK BCBS",
          payerId: "54771",
        },
        serviceLines: [
          {
            hcpcsCode: "E0601",
            modifiers: ["RR", "KX"],
            billedCents: 24999,
            units: 1,
            serviceDate: "2026-05-12",
            diagnosisPointers: [1],
          },
        ],
      },
    ],
    control,
    usageIndicator: "T",
    ...overrides,
  };
}

describe("sanitizeElement", () => {
  it("strips X12 reserved delimiters", () => {
    expect(sanitizeElement("foo*bar~baz:qux")).toBe("foobarbazqux");
  });
  it("returns empty string for null/undefined", () => {
    expect(sanitizeElement(null)).toBe("");
    expect(sanitizeElement(undefined)).toBe("");
  });
  it("trims surrounding whitespace", () => {
    expect(sanitizeElement("  hello  ")).toBe("hello");
  });
});

describe("digitsOnly", () => {
  it("strips non-digit chars", () => {
    expect(digitsOnly("+1 (814) 471-0627")).toBe("18144710627");
  });
});

describe("toCcyymmdd", () => {
  it("converts ISO to CCYYMMDD", () => {
    expect(toCcyymmdd("2026-05-19")).toBe("20260519");
  });
  it("throws on malformed input", () => {
    expect(() => toCcyymmdd("not-a-date")).toThrow(/Invalid date/);
    // Trailing newline / smuggled delimiter must be rejected
    expect(() => toCcyymmdd("2026-05-19~SE")).toThrow(/Invalid date/);
  });
});

describe("centsToMoney", () => {
  it("formats cents as dollars.cents", () => {
    expect(centsToMoney(24999)).toBe("249.99");
    expect(centsToMoney(0)).toBe("0.00");
    expect(centsToMoney(5)).toBe("0.05");
    expect(centsToMoney(100000)).toBe("1000.00");
  });
  it("rejects non-integer or negative input", () => {
    expect(() => centsToMoney(1.5)).toThrow();
    expect(() => centsToMoney(-1)).toThrow();
  });
});

describe("allocateControlNumbers", () => {
  it("emits 9-digit zero-padded ISA13", () => {
    const c = allocateControlNumbers({ submittedAt: FIXED_BUILT_AT });
    expect(c.interchangeControlNumber).toMatch(/^\d{9}$/);
  });
  it("is strictly monotonic when sequence increases", () => {
    const a = allocateControlNumbers({
      submittedAt: FIXED_BUILT_AT,
      sequence: 1,
    });
    const b = allocateControlNumbers({
      submittedAt: FIXED_BUILT_AT,
      sequence: 2,
    });
    expect(Number(b.interchangeControlNumber)).toBeGreaterThan(
      Number(a.interchangeControlNumber),
    );
  });
  it("honours previousHighest to guarantee monotonicity across restarts", () => {
    const c = allocateControlNumbers({
      submittedAt: FIXED_BUILT_AT,
      sequence: 1,
      previousHighest: "999999999",
    });
    expect(c.interchangeControlNumber).toBe("000000000");
    // 999999999 + 1 wraps in the spec sense; we deliberately wrap so
    // the next field stays within 9 digits. Office Ally accepts a
    // wrap once the receiver has acked the prior batch.
  });
});

describe("build837P", () => {
  it("rejects an empty claim batch", () => {
    expect(() => build837P({ ...fixtureInput(), claims: [] })).toThrow(
      /claims must be non-empty/,
    );
  });

  it("rejects a claim with no service lines", () => {
    const input = fixtureInput();
    input.claims[0]!.serviceLines = [];
    expect(() => build837P(input)).toThrow(/no service lines/);
  });

  it("rejects a claim with no diagnoses", () => {
    const input = fixtureInput();
    input.claims[0]!.diagnosisCodes = [];
    expect(() => build837P(input)).toThrow(/no diagnosis codes/);
  });

  it("rejects > 12 diagnoses", () => {
    const input = fixtureInput();
    input.claims[0]!.diagnosisCodes = Array.from(
      { length: 13 },
      (_, i) => `G47.${i.toString().padStart(2, "0")}`,
    );
    expect(() => build837P(input)).toThrow(/> 12 diagnoses/);
  });

  it("emits a well-formed ISA / GS / ST / SE / GE / IEA envelope", () => {
    const { payload, claimCount } = build837P(fixtureInput());
    expect(claimCount).toBe(1);
    // Must start with ISA and end with IEA segment
    expect(payload.startsWith("ISA*")).toBe(true);
    expect(payload.endsWith("~")).toBe(true);
    expect(payload).toContain("~GS*HC*");
    expect(payload).toContain("~ST*837*");
    expect(payload).toContain("~SE*");
    expect(payload).toContain("~GE*1*");
    expect(payload).toContain("~IEA*1*");
  });

  it("places the version qualifier 005010X222A1 in both GS08 and ST03", () => {
    const { payload } = build837P(fixtureInput());
    const gsMatch = payload.match(/~GS\*[^~]+~/);
    const stMatch = payload.match(/~ST\*837\*\d+\*([^~]+)~/);
    expect(gsMatch?.[0]).toContain("005010X222A1");
    expect(stMatch?.[1]).toBe("005010X222A1");
  });

  it("emits CLM05 composite (place-of-service:B:1)", () => {
    const { payload } = build837P(fixtureInput());
    expect(payload).toMatch(/~CLM\*CLM-0001\*249\.99\*\*\*12:B:1\*Y\*A\*Y\*Y~/);
  });

  it("defaults to frequency 1 and emits no REF*F8 for an original claim", () => {
    const { payload } = build837P(fixtureInput());
    expect(payload).toMatch(/12:B:1\*/);
    expect(payload).not.toContain("REF*F8");
  });

  it("emits CLM05 frequency 7 + REF*F8 for a corrected (replacement) claim", () => {
    const base = fixtureInput();
    const input = {
      ...base,
      claims: [
        {
          ...base.claims[0]!,
          claimFrequencyCode: "7" as const,
          originalClaimNumber: "PAYERICN123",
        },
      ],
    };
    const { payload } = build837P(input);
    // Without these the payer would adjudicate the replacement as a duplicate.
    expect(payload).toMatch(/~CLM\*CLM-0001\*249\.99\*\*\*12:B:7\*/);
    expect(payload).toContain("~REF*F8*PAYERICN123~");
  });

  it("emits CLM05 frequency 8 + REF*F8 for a void/cancel claim", () => {
    const base = fixtureInput();
    const input = {
      ...base,
      claims: [
        {
          ...base.claims[0]!,
          claimFrequencyCode: "8" as const,
          originalClaimNumber: "ICN-VOID-9",
        },
      ],
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~CLM\*CLM-0001\*249\.99\*\*\*12:B:8\*/);
    expect(payload).toContain("~REF*F8*ICN-VOID-9~");
  });

  it("omits REF*F8 when frequency is 7 but no original claim number is known", () => {
    const base = fixtureInput();
    const input = {
      ...base,
      claims: [
        {
          ...base.claims[0]!,
          claimFrequencyCode: "7" as const,
          originalClaimNumber: null,
        },
      ],
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/12:B:7\*/);
    expect(payload).not.toContain("REF*F8");
  });

  it("computes CLM02 from the service-line sum, not a drifted header total", () => {
    const base = fixtureInput();
    const input = {
      ...base,
      // Header total drifted to 999.99, but the single line sums to 249.99.
      claims: [{ ...base.claims[0]!, totalBilledCents: 99999 }],
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~CLM\*CLM-0001\*249\.99\*/);
    expect(payload).not.toContain("*999.99*");
  });

  it("uses ABK for principal diagnosis and ABF for subsequent", () => {
    const input = fixtureInput();
    input.claims[0]!.diagnosisCodes = ["G47.33", "E11.9"];
    const { payload } = build837P(input);
    // ABK on the first, ABF on the second, ICD-10 periods stripped
    expect(payload).toMatch(/~HI\*ABK:G4733\*ABF:E119~/);
  });

  it("emits one LX / SV1 / DTP triplet per service line", () => {
    const input = fixtureInput();
    input.claims[0]!.serviceLines.push({
      hcpcsCode: "A7030",
      modifiers: ["NU"],
      billedCents: 5999,
      units: 1,
      serviceDate: "2026-05-12",
      diagnosisPointers: [1],
    });
    const { payload } = build837P(input);
    expect((payload.match(/~LX\*/g) ?? []).length).toBe(2);
    expect((payload.match(/~SV1\*/g) ?? []).length).toBe(2);
    expect((payload.match(/~DTP\*472\*D8\*/g) ?? []).length).toBe(2);
    expect(payload).toContain("HC:E0601:RR:KX");
    expect(payload).toContain("HC:A7030:NU");
  });

  it("uses the payer organization name and Office Ally payer ID on 2010BB", () => {
    const { payload } = build837P(fixtureInput());
    expect(payload).toMatch(/~NM1\*PR\*2\*HIGHMARK BCBS[^~]*\*PI\*54771~/);
  });

  it("emits REF*G1 only when a prior-auth number is supplied", () => {
    const withAuth = build837P(fixtureInput());
    expect(withAuth.payload).toContain("~REF*G1*PA-ABCD~");

    const input = fixtureInput();
    input.claims[0]!.priorAuthNumber = null;
    const withoutAuth = build837P(input);
    expect(withoutAuth.payload).not.toContain("REF*G1");
  });

  it("strips reserved delimiters from caller-supplied free text", () => {
    const input = fixtureInput();
    input.claims[0]!.subscriber.firstName = "MARY*JANE";
    input.claims[0]!.subscriber.lastName = "O~CONNOR";
    const { payload } = build837P(input);
    // The * and ~ characters were stripped so the NM1 boundaries
    // remain trustworthy
    expect(payload).toContain("OCONNOR");
    expect(payload).toContain("MARYJANE");
    expect((payload.match(/~NM1\*IL/g) ?? []).length).toBe(1);
  });

  it("SE segment count includes ST through SE inclusive", () => {
    const { payload } = build837P(fixtureInput());
    // Slice out the inner transaction set
    const stIdx = payload.indexOf("ST*");
    const seMatch = payload.slice(stIdx).match(/~SE\*(\d+)\*/);
    expect(seMatch).not.toBeNull();
    const declared = Number(seMatch![1]);
    // Count actual segments between ST and SE inclusive
    const inner = payload.slice(stIdx, payload.indexOf("~GE*"));
    const actual = inner.split("~").filter((s) => s.length > 0).length;
    expect(declared).toBe(actual);
  });

  it("emits ISA13 padded to 9 digits", () => {
    const { payload, interchangeControlNumber } = build837P(fixtureInput());
    expect(interchangeControlNumber).toMatch(/^\d{9}$/);
    // ISA has 16 elements, with element 13 being the control number;
    // walk by counting the first 13 * chars and asserting padding
    const isaTrailer = payload.match(/~IEA\*1\*(\d{9})~$/);
    expect(isaTrailer?.[1]).toBe(interchangeControlNumber);
  });

  it("handles multiple claims by emitting one subscriber HL per claim", () => {
    const input = fixtureInput();
    input.claims.push({
      ...input.claims[0]!,
      internalClaimId: "CLM-0002",
      subscriber: {
        ...input.claims[0]!.subscriber,
        firstName: "JOHN",
        lastName: "SMITH",
        memberId: "M987654321",
      },
    });
    const { payload, claimCount } = build837P(input);
    expect(claimCount).toBe(2);
    expect((payload.match(/~HL\*\d+\*1\*22\*0~/g) ?? []).length).toBe(2);
    expect((payload.match(/~CLM\*/g) ?? []).length).toBe(2);
  });

  it("emits production indicator P when usageIndicator is P", () => {
    const input = fixtureInput();
    input.usageIndicator = "P";
    const { payload } = build837P(input);
    // ISA15 is the 15th element. ISA always starts with a fixed prefix;
    // we just verify the `*P*` marker appears in the ISA segment
    const isa = payload.slice(0, payload.indexOf("~"));
    expect(isa.endsWith("*P*:")).toBe(true);
  });

  it("omits loop 2310B / 2310D / 2320 when those refs are not supplied", () => {
    const { payload } = build837P(fixtureInput());
    expect(payload).not.toContain("NM1*82");
    expect(payload).not.toContain("NM1*DN");
    expect(payload).not.toMatch(/~SBR\*[ST]\*/);
  });

  it("bills a secondary claim: 2000B SBR*S + 2320 SBR*P with AMT*D prior-paid", () => {
    const input = fixtureInput();
    input.claims[0]!.payerResponsibility = "S";
    input.claims[0]!.otherSubscriber = {
      payerResponsibility: "P",
      priorPayerPaidCents: 12000,
      subscriber: {
        firstName: "JANE",
        lastName: "DOE",
        dateOfBirth: "1965-04-12",
        gender: "F",
        memberId: "MCR123456",
        address: {
          line1: "200 ELM ST",
          city: "ALTOONA",
          state: "PA",
          zip: "16601",
        },
        relationshipCode: "18",
      },
      payer: { organizationName: "MEDICARE PART B", payerId: "MEDPB" },
    };
    const { payload } = build837P(input);
    // Destination (secondary) subscriber loop declares S.
    expect(payload).toMatch(/~SBR\*S\*/);
    // 2320 discloses the primary that already adjudicated, with AMT*D.
    expect(payload).toMatch(/~SBR\*P\*/);
    expect(payload).toContain("~AMT*D*120.00~");
  });

  it("defaults the destination SBR01 to P when payerResponsibility is unset", () => {
    const { payload } = build837P(fixtureInput());
    expect(payload).toMatch(/~SBR\*P\*/);
  });

  it("emits loop 2310B (rendering provider) with NM1*82 + REF*0B", () => {
    const input = fixtureInput();
    input.claims[0]!.renderingProvider = {
      npi: "1023456788",
      firstName: "ROBIN",
      lastName: "ASHTON",
      stateLicenseNumber: "PA-MD-12345",
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~NM1\*82\*1\*ASHTON\*ROBIN\*[^~]*XX\*1023456788~/);
    expect(payload).toContain("~REF*0B*PA-MD-12345~");
  });

  it("emits loop 2310D (referring provider) with NM1*DN", () => {
    const input = fixtureInput();
    input.claims[0]!.referringProvider = {
      npi: "1700987654",
      firstName: "ALEX",
      lastName: "RIVERA",
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~NM1\*DN\*1\*RIVERA\*ALEX\*[^~]*XX\*1700987654~/);
  });

  it("emits loop 2320/2330 COB with prior-payer paid amount", () => {
    const input = fixtureInput();
    input.claims[0]!.otherSubscriber = {
      payerResponsibility: "S",
      priorPayerPaidCents: 12345,
      subscriber: {
        firstName: "JANE",
        lastName: "DOE",
        dateOfBirth: "1965-04-12",
        gender: "F",
        memberId: "MED-XYZ-7",
        address: {
          line1: "200 ELM ST",
          city: "ALTOONA",
          state: "PA",
          zip: "16601",
        },
        relationshipCode: "18",
      },
      payer: {
        organizationName: "MEDICARE PART B",
        payerId: "12502",
      },
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~SBR\*S\*18\*\*\*\*\*\*\*CI~/);
    expect(payload).toContain("~AMT*D*123.45~");
    expect(payload).toMatch(/~NM1\*IL\*1\*DOE\*JANE[^~]*MI\*MED-XYZ-7~/);
    expect(payload).toMatch(/~NM1\*PR\*2\*MEDICARE PART B[^~]*PI\*12502~/);
  });

  it("2330B falls back to the payer NAME (no PI id) when the other-payer id is unknown", () => {
    const input = fixtureInput();
    input.claims[0]!.otherSubscriber = {
      payerResponsibility: "P",
      priorPayerPaidCents: 5000,
      subscriber: {
        firstName: "JANE",
        lastName: "DOE",
        dateOfBirth: "1965-04-12",
        gender: "F",
        memberId: "MED-XYZ-7",
        address: {
          line1: "200 ELM ST",
          city: "ALTOONA",
          state: "PA",
          zip: "16601",
        },
        relationshipCode: "18",
      },
      payer: { organizationName: "SOME LOCAL PLAN", payerId: "" },
    };
    const { payload } = build837P(input);
    // The other-payer 2330B NM1 carries the name but NO PI identifier (a name
    // is not a valid payer id) — better a missing id the clearinghouse flags
    // than a name-as-id that mis-routes the COB loop.
    expect(payload).toMatch(/~NM1\*PR\*2\*SOME LOCAL PLAN[ ]*~/);
    expect(payload).not.toMatch(/~NM1\*PR\*2\*SOME LOCAL PLAN[^~]*PI\*/);
    // ...and the prior-paid (AMT*D) disclosure is still emitted.
    expect(payload).toContain("~AMT*D*50.00~");
  });

  it("omits AMT*D when prior payer hasn't paid yet (null priorPayerPaidCents)", () => {
    const input = fixtureInput();
    input.claims[0]!.otherSubscriber = {
      payerResponsibility: "P",
      priorPayerPaidCents: null,
      subscriber: input.claims[0]!.subscriber,
      payer: { organizationName: "PA MEDICAID", payerId: "23284" },
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~SBR\*P\*/);
    expect(payload).not.toContain("AMT*D*");
  });

  it("emits a 2300 NTE*ADD claim note when claimNote is supplied", () => {
    const input = fixtureInput();
    input.claims[0]!.claimNote =
      "Custom interface accessory; MSRP $129.00 per manufacturer.";
    const { payload } = build837P(input);
    expect(payload).toContain(
      "~NTE*ADD*Custom interface accessory; MSRP $129.00 per manufacturer.~",
    );
  });

  it("omits the 2300 NTE when no claim note is supplied", () => {
    const { payload } = build837P(fixtureInput());
    expect(payload).not.toContain("NTE*ADD");
  });

  it("truncates the claim NTE narrative to the 80-char NTE02 limit", () => {
    const input = fixtureInput();
    input.claims[0]!.claimNote = "X".repeat(120);
    const { payload } = build837P(input);
    expect(payload).toContain(`~NTE*ADD*${"X".repeat(80)}~`);
    expect(payload).not.toContain("X".repeat(81));
  });

  it("emits a 2400 line-level NTE*ADD after the line's service date", () => {
    const input = fixtureInput();
    input.claims[0]!.serviceLines[0]!.hcpcsCode = "E1399";
    input.claims[0]!.serviceLines[0]!.note =
      "Miscellaneous DME - replacement headgear strap; MSRP $24.00.";
    const { payload } = build837P(input);
    // NTE follows the DTP*472 service-date segment within loop 2400.
    expect(payload).toMatch(
      /~DTP\*472\*D8\*\d{8}~NTE\*ADD\*Miscellaneous DME - replacement headgear strap; MSRP \$24\.00\.~/,
    );
  });

  it("strips X12 reserved delimiters (e.g. ':') from NTE narrative text", () => {
    const input = fixtureInput();
    input.claims[0]!.claimNote = "Note: see attached.";
    const { payload } = build837P(input);
    // The ':' component separator must never reach the wire inside an element.
    expect(payload).toContain("~NTE*ADD*Note see attached.~");
  });

  it("emits loop 2420E line-level ordering provider (NM1*DK) when supplied", () => {
    const input = fixtureInput();
    input.claims[0]!.serviceLines[0]!.orderingProvider = {
      npi: "1801234569",
      firstName: "DANA",
      lastName: "OKAFOR",
      stateLicenseNumber: "PA-MD-99887",
      address: {
        line1: "55 CLINIC WAY",
        city: "HERSHEY",
        state: "PA",
        zip: "17033",
      },
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~NM1\*DK\*1\*OKAFOR\*DANA\*[^~]*XX\*1801234569~/);
    // N3/N4 address emitted because the ordering provider carries one.
    expect(payload).toContain("~N3*55 CLINIC WAY~");
    expect(payload).toMatch(/~N4\*HERSHEY\*PA\*17033~/);
    expect(payload).toContain("~REF*0B*PA-MD-99887~");
  });

  it("omits N3/N4 on 2420E when the ordering provider has no address", () => {
    const input = fixtureInput();
    input.claims[0]!.serviceLines[0]!.orderingProvider = {
      npi: "1801234569",
      firstName: "DANA",
      lastName: "OKAFOR",
    };
    const { payload } = build837P(input);
    expect(payload).toMatch(/~NM1\*DK\*1\*OKAFOR\*DANA\*[^~]*XX\*1801234569~/);
    // Only the billing-provider + subscriber N3 segments — no ordering-provider address.
    expect((payload.match(/~N3\*/g) ?? []).length).toBe(2);
  });

  it("omits loop 2420E when no ordering provider is supplied", () => {
    const { payload } = build837P(fixtureInput());
    expect(payload).not.toContain("NM1*DK");
  });

  it("keeps the SE segment count correct with NTE + 2420E segments added", () => {
    const input = fixtureInput();
    input.claims[0]!.claimNote = "Claim narrative.";
    input.claims[0]!.serviceLines[0]!.note = "Line narrative.";
    input.claims[0]!.serviceLines[0]!.orderingProvider = {
      npi: "1801234569",
      firstName: "DANA",
      lastName: "OKAFOR",
      address: {
        line1: "55 CLINIC WAY",
        city: "HERSHEY",
        state: "PA",
        zip: "17033",
      },
    };
    const { payload } = build837P(input);
    const stIdx = payload.indexOf("ST*");
    const seMatch = payload.slice(stIdx).match(/~SE\*(\d+)\*/);
    const declared = Number(seMatch![1]);
    const inner = payload.slice(stIdx, payload.indexOf("~GE*"));
    const actual = inner.split("~").filter((s) => s.length > 0).length;
    expect(declared).toBe(actual);
  });

  it("multi-claim batch keeps the SE segment count correct", () => {
    const input = fixtureInput();
    input.claims.push({
      ...input.claims[0]!,
      internalClaimId: "CLM-0002",
      subscriber: {
        ...input.claims[0]!.subscriber,
        firstName: "BOB",
        lastName: "SMITH",
        memberId: "X999",
      },
    });
    const { payload } = build837P(input);
    const stIdx = payload.indexOf("ST*");
    const seMatch = payload.slice(stIdx).match(/~SE\*(\d+)\*/);
    const declared = Number(seMatch![1]);
    const inner = payload.slice(stIdx, payload.indexOf("~GE*"));
    const actual = inner.split("~").filter((s) => s.length > 0).length;
    expect(declared).toBe(actual);
  });
});
