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
});
