import { describe, expect, it } from "vitest";

import { parse835 } from "./parse-835";

// A compact but realistic 835 covering: 2 claims, one paid in full,
// one denied with CARC 27. Service-line CAS and PLB included.
const ERA_835 = [
  "ISA*00*          *00*          *ZZ*HIGHMARK01     *ZZ*PENNPAPS01     *260519*1437*^*00501*000000123*0*P*:~",
  "GS*HP*HIGHMARK01*PENNPAPS01*20260519*1437*123*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*1250.50*C*ACH*CTX*01*111111111*DA*123456789*1512345678**01*222222222*DA*987654321*20260519~",
  "TRN*1*CHK-20260519-001*1512345678~",
  "REF*EV*PENNPAPS01~",
  "DTM*405*20260519~",
  "N1*PR*HIGHMARK BCBS*XV*54771~",
  "N3*120 FIFTH AVE~",
  "N4*PITTSBURGH*PA*15222~",
  "N1*PE*PENNPAPS INC*XX*1234567893~",
  "LX*1~",
  // Paid claim — primary, $249.99 charged, $200.00 paid, $49.99 patient resp.
  "CLP*CLM-0001*1*249.99*200.00*49.99*MB*12345*11*1~",
  "CAS*PR*1*49.99~",
  "NM1*QC*1*DOE*JANE~",
  "SVC*HC:E0601:RR:KX*249.99*200.00**1*1~",
  "DTM*472*20260512~",
  // Denied claim — status 4, full charge gets CO 27 (after term).
  "CLP*CLM-0002*4*150.00*0.00*0.00*MB*9999*11*1~",
  "CAS*CO*27*150.00~",
  "NM1*QC*1*SMITH*BOB~",
  "SVC*HC:A7030*150.00*0.00**1*1~",
  "DTM*472*20260512~",
  // Provider-level adjustment — $5 forward-balance carry.
  "PLB*1234567893*20260519*FB:1*5.00~",
  "SE*22*0001~",
  "GE*1*123~",
  "IEA*1*000000123~",
].join("");

describe("parse835", () => {
  it("extracts the envelope totals", () => {
    const parsed = parse835(ERA_835);
    expect(parsed.totalPaidCents).toBe(125050);
    expect(parsed.checkOrEftNumber).toBe("CHK-20260519-001");
    expect(parsed.originatingPayerId).toBe("1512345678");
    expect(parsed.paymentDate).toBe("2026-05-19");
    expect(parsed.payerName).toBe("HIGHMARK BCBS");
    expect(parsed.payerId).toBe("54771");
    expect(parsed.payeeName).toBe("PENNPAPS INC");
    expect(parsed.payeeNpi).toBe("1234567893");
    expect(parsed.receiverIdentifier).toBe("PENNPAPS01");
  });

  it("emits one claim per CLP segment", () => {
    const parsed = parse835(ERA_835);
    expect(parsed.claims).toHaveLength(2);
  });

  it("captures the paid claim with PR adjustment and one service line", () => {
    const parsed = parse835(ERA_835);
    const paid = parsed.claims[0]!;
    expect(paid.patientControlNumber).toBe("CLM-0001");
    expect(paid.claimStatusCode).toBe("1");
    expect(paid.totalChargeCents).toBe(24999);
    expect(paid.paidCents).toBe(20000);
    expect(paid.patientResponsibilityCents).toBe(4999);
    expect(paid.isPaid).toBe(true);
    expect(paid.isDenied).toBe(false);
    expect(paid.patientLastName).toBe("DOE");
    expect(paid.patientFirstName).toBe("JANE");
    expect(paid.adjustments).toEqual([
      { groupCode: "PR", reasonCode: "1", amountCents: 4999, quantity: null },
    ]);
    expect(paid.serviceLines).toHaveLength(1);
    expect(paid.serviceLines[0]!.hcpcsCode).toBe("E0601");
    expect(paid.serviceLines[0]!.modifiers).toEqual(["RR", "KX"]);
    expect(paid.serviceLines[0]!.billedCents).toBe(24999);
    expect(paid.serviceLines[0]!.paidCents).toBe(20000);
    expect(paid.serviceLines[0]!.serviceDate).toBe("2026-05-12");
  });

  it("flags the denied claim with CO 27 adjustment", () => {
    const parsed = parse835(ERA_835);
    const denied = parsed.claims[1]!;
    expect(denied.patientControlNumber).toBe("CLM-0002");
    expect(denied.claimStatusCode).toBe("4");
    expect(denied.isDenied).toBe(true);
    expect(denied.isPaid).toBe(false);
    expect(denied.adjustments).toEqual([
      { groupCode: "CO", reasonCode: "27", amountCents: 15000, quantity: null },
    ]);
  });

  it("captures provider-level adjustments (PLB)", () => {
    const parsed = parse835(ERA_835);
    expect(parsed.providerAdjustments).toEqual([
      { groupCode: "FB", amountCents: 500 },
    ]);
  });

  it("returns empty claims array for an empty or malformed payload", () => {
    expect(parse835("").claims).toEqual([]);
    expect(parse835("notedi").claims).toEqual([]);
  });
});
