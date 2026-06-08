import { describe, it, expect } from "vitest";

import { deriveOutcome, parse277 } from "./parse-277";

const HEADER =
  "ISA*00*          *00*          *ZZ*OFFALLY        *ZZ*SUB123         *260601*1330*^*00501*000000001*0*T*:~" +
  "GS*HN*OFFALLY*SUB123*20260601*1330*1*X*005010X212~" +
  "ST*277*0001*005010X212~";
const FOOTER = "SE*9*0001~GE*1*1~IEA*1*000000001~";

describe("deriveOutcome", () => {
  it("maps category-code families to coarse outcomes", () => {
    expect(deriveOutcome("F1")).toBe("finalized_paid");
    expect(deriveOutcome("F3")).toBe("finalized_paid");
    expect(deriveOutcome("F2")).toBe("finalized_denied");
    expect(deriveOutcome("F4")).toBe("finalized_other");
    expect(deriveOutcome("P1")).toBe("pending");
    expect(deriveOutcome("A2")).toBe("acknowledged");
    expect(deriveOutcome("E0")).toBe("error");
    expect(deriveOutcome("D0")).toBe("error");
    expect(deriveOutcome(null)).toBe("unknown");
  });
});

describe("parse277", () => {
  it("parses a single finalized-denied claim", () => {
    const edi =
      HEADER +
      "TRN*2*SUB123-000000001-0001-abcd~" +
      "STC*F2:88*20260601*WQ*200~" +
      "REF*EJ*CLM-9~REF*1K*PAY-9~" +
      FOOTER;
    const parsed = parse277(edi);
    expect(parsed.traceReference).toBe("SUB123-000000001-0001-abcd");
    expect(parsed.claims).toHaveLength(1);
    const c = parsed.claims[0]!;
    expect(c.categoryCode).toBe("F2");
    expect(c.statusCode).toBe("88");
    expect(c.statusDate).toBe("20260601");
    expect(c.totalChargeCents).toBe(20000);
    expect(c.totalPaidCents).toBeNull();
    expect(c.claimControlNumber).toBe("CLM-9");
    expect(c.outcome).toBe("finalized_denied");
  });

  it("parses multiple claims, each with its own TRN", () => {
    const edi =
      HEADER +
      "TRN*2*TRACE-A~STC*P1:20*20260601~REF*EJ*CLM-A~" +
      "TRN*2*TRACE-B~STC*F1:65*20260601*WQ*100*100~REF*EJ*CLM-B~" +
      FOOTER;
    const parsed = parse277(edi);
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.claims[0]!.traceReference).toBe("TRACE-A");
    expect(parsed.claims[0]!.outcome).toBe("pending");
    expect(parsed.claims[0]!.claimControlNumber).toBe("CLM-A");
    expect(parsed.claims[1]!.traceReference).toBe("TRACE-B");
    expect(parsed.claims[1]!.outcome).toBe("finalized_paid");
    expect(parsed.claims[1]!.totalPaidCents).toBe(10000);
  });

  it("returns no claims for a 277 with no STC/TRN", () => {
    expect(parse277(HEADER + FOOTER).claims).toHaveLength(0);
  });
});
