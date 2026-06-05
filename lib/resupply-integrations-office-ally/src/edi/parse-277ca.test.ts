import { describe, expect, it } from "vitest";

import { parse277CA } from "./parse-277ca";

const X = [
  "ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*PENNPAPS01     *260519*1437*^*00501*000000200*0*P*:~",
  "GS*HN*OFFCLY*PENNPAPS01*20260519*1437*200*X*005010X214~",
  "ST*277*0001~",
  "BHT*0085*08*PF-CLAIMS-1*20260519*1437*TH~",
  "HL*1**20*1~",
  "NM1*PR*2*OFFICE ALLY*****46*OFFCLY~",
  "HL*2*1*21*1~",
  "NM1*41*2*PENNPAPS INC*****46*PENNPAPS01~",
  "HL*3*2*19*1~",
  "NM1*85*2*PENNPAPS INC*****XX*1234567893~",
  "HL*4*3*PT~",
  "NM1*QC*1*DOE*JANE****MI*M123456789~",
  "TRN*2*CLM-0001~",
  "STC*A2:20:PR*20260519*WQ*249.99~",
  "REF*1K*PAYER-CLAIM-9988~",
  "HL*5*3*PT~",
  "NM1*QC*1*SMITH*BOB****MI*M987654321~",
  "TRN*2*CLM-0002~",
  "STC*A7:24:PR*20260519*U~",
  "SE*16*0001~",
  "GE*1*200~",
  "IEA*1*000000200~",
].join("");

describe("parse277CA", () => {
  it("emits one row per claim block", () => {
    const r = parse277CA(X);
    expect(r.claims).toHaveLength(2);
  });

  it("marks A2 status as accepted", () => {
    const r = parse277CA(X);
    expect(r.claims[0]!.outcome).toBe("accepted");
    expect(r.claims[0]!.traceNumber).toBe("CLM-0001");
    expect(r.claims[0]!.subscriberLastName).toBe("DOE");
    expect(r.claims[0]!.payerClaimRef).toBe("PAYER-CLAIM-9988");
    expect(r.claims[0]!.totalChargeCents).toBe(24999);
  });

  it("marks A7 status as rejected", () => {
    const r = parse277CA(X);
    expect(r.claims[1]!.outcome).toBe("rejected");
    expect(r.claims[1]!.traceNumber).toBe("CLM-0002");
    expect(r.claims[1]!.subscriberLastName).toBe("SMITH");
  });

  // Regression: claims for a dependent (HL level 23) distinct from the
  // subscriber (level 22) must be parsed, and the empty subscriber parent
  // block must NOT emit a spurious claim row.
  it("parses a dependent-patient (HL 23) claim and skips the empty subscriber parent", () => {
    const DEP = [
      "ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*PENNPAPS01     *260519*1437*^*00501*000000201*0*P*:~",
      "GS*HN*OFFCLY*PENNPAPS01*20260519*1437*201*X*005010X214~",
      "ST*277*0001~",
      "BHT*0085*08*PF-CLAIMS-2*20260519*1437*TH~",
      "HL*1**20*1~",
      "NM1*PR*2*OFFICE ALLY*****46*OFFCLY~",
      "HL*2*1*21*1~",
      "NM1*41*2*PENNPAPS INC*****46*PENNPAPS01~",
      "HL*3*2*19*1~",
      "NM1*85*2*PENNPAPS INC*****XX*1234567893~",
      // Subscriber parent — no claim hangs off this HL.
      "HL*4*3*22*1~",
      "NM1*IL*1*DOE*JOHN****MI*S111111111~",
      // Dependent IS the patient; the claim ack hangs off level 23.
      "HL*5*4*23~",
      "NM1*QC*1*DOE*JIMMY****MI*M222222222~",
      "TRN*2*CLM-DEP-1~",
      "STC*A2:20:PR*20260519*WQ*99.99~",
      "REF*1K*PAYER-DEP-1~",
      "SE*14*0001~",
      "GE*1*201~",
      "IEA*1*000000201~",
    ].join("");
    const r = parse277CA(DEP);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.traceNumber).toBe("CLM-DEP-1");
    expect(r.claims[0]!.outcome).toBe("accepted");
    expect(r.claims[0]!.payerClaimRef).toBe("PAYER-DEP-1");
    expect(r.claims[0]!.patientId).toBe("M222222222");
  });
});
