import { describe, it, expect } from "vitest";

import { build276, type Build276Input } from "./276";
import { parse277 } from "./parse-277";

function input(over: Partial<Build276Input> = {}): Build276Input {
  return {
    submitter: {
      etin: "SUB123",
      organizationName: "Penn Home Medical",
      npi: "1234567890",
    },
    receiver: { interchangeId: "OFFALLY", organizationName: "Office Ally" },
    payer: { organizationName: "Aetna", payerId: "60054" },
    subscriber: {
      firstName: "Jordan",
      lastName: "Rivera",
      memberId: "W123456789",
    },
    claim: {
      claimControlNumber: "CLM-0001",
      totalBilledCents: 12500,
      serviceDateFrom: "2026-05-01",
    },
    control: {
      interchangeControlNumber: "000000042",
      groupControlNumber: "42",
      transactionSetControlNumber: "0001",
      builtAt: Date.UTC(2026, 5, 1, 13, 30),
    },
    usageIndicator: "T",
    ...over,
  };
}

describe("build276", () => {
  it("emits a well-formed 005010X212 claim-status request", () => {
    const built = build276(input());
    const p = built.payload;
    expect(p.startsWith("ISA*")).toBe(true);
    expect(p).toContain("GS*HR*");
    expect(p).toContain("ST*276*0001*005010X212~");
    expect(p).toContain("BHT*0010*13*");
    // payer / receiver / provider / subscriber loops
    expect(p).toContain("NM1*PR*2*Aetna*****PI*60054~");
    expect(p).toContain("NM1*41*2*"); // information receiver (submitter)
    expect(p).toContain("NM1*1P*2*"); // service provider
    expect(p).toContain("NM1*IL*1*Rivera*Jordan****MI*W123456789~");
    // claim tracking
    expect(p).toContain("REF*EJ*CLM-0001~");
    expect(p).toContain("AMT*T3*125.00~");
    expect(p).toContain("DTP*472*RD8*20260501-20260501~");
    expect(p).toMatch(/SE\*\d+\*0001~GE\*1\*42~IEA\*1\*000000042~$/);
    // trace ref is echoed in TRN02 + carries the ISA control number
    expect(built.traceReference).toContain("000000042");
    expect(p).toContain(`TRN*1*${built.traceReference}~`);
  });

  it("includes the payer claim number (REF*1K) only when supplied", () => {
    expect(build276(input()).payload).not.toContain("REF*1K*");
    const withPayerClaim = build276(
      input({
        claim: {
          claimControlNumber: "CLM-0002",
          payerClaimControlNumber: "PAY-999",
          totalBilledCents: 5000,
          serviceDateFrom: "2026-05-02",
        },
      }),
    );
    expect(withPayerClaim.payload).toContain("REF*1K*PAY-999~");
  });

  it("round-trips: the trace it stamps is parseable from a matching 277", () => {
    const built = build276(input());
    // A minimal 277 that echoes the trace + finalized-payment status.
    const resp =
      `ISA*00*          *00*          *ZZ*OFFALLY        *ZZ*SUB123         *260601*1330*^*00501*000000042*0*T*:~` +
      `GS*HN*OFFALLY*SUB123*20260601*1330*42*X*005010X212~` +
      `ST*277*0001*005010X212~` +
      `TRN*2*${built.traceReference}~` +
      `STC*F1:65*20260601*WQ*125*100~` +
      `REF*EJ*CLM-0001~REF*1K*PAY-777~` +
      `SE*5*0001~GE*1*42~IEA*1*000000042~`;
    const parsed = parse277(resp);
    expect(parsed.traceReference).toBe(built.traceReference);
    expect(parsed.claims).toHaveLength(1);
    const c = parsed.claims[0]!;
    expect(c.claimControlNumber).toBe("CLM-0001");
    expect(c.payerClaimControlNumber).toBe("PAY-777");
    expect(c.categoryCode).toBe("F1");
    expect(c.statusCode).toBe("65");
    expect(c.totalChargeCents).toBe(12500);
    expect(c.totalPaidCents).toBe(10000);
    expect(c.outcome).toBe("finalized_paid");
  });
});
