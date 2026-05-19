import { describe, expect, it } from "vitest";

import { parse999 } from "./parse-999";

const ACCEPTED_999 = [
  "ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*PENNPAPS01     *260519*1437*^*00501*000000124*0*P*:~",
  "GS*FA*OFFCLY*PENNPAPS01*20260519*1437*124*X*005010X231A1~",
  "ST*999*0001~",
  "AK1*HC*123~",
  "AK2*837*0001~",
  "IK5*A~",
  "AK9*A*1*1*1~",
  "SE*5*0001~",
  "GE*1*124~",
  "IEA*1*000000124~",
].join("");

const REJECTED_999 = [
  "ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*PENNPAPS01     *260519*1437*^*00501*000000125*0*P*:~",
  "GS*FA*OFFCLY*PENNPAPS01*20260519*1437*125*X*005010X231A1~",
  "ST*999*0002~",
  "AK1*HC*125~",
  "AK2*837*0002~",
  "IK3*NM1*42**8~",
  "IK4*9*66*7*INVALID~",
  "CTX*SITUATIONAL TRIGGER:NM109 MUST BE 10 DIGITS~",
  "IK5*R*5~",
  "AK9*R*1*1*0~",
  "SE*8*0002~",
  "GE*1*125~",
  "IEA*1*000000125~",
].join("");

describe("parse999", () => {
  it("reports an accepted ack", () => {
    const r = parse999(ACCEPTED_999);
    expect(r.disposition).toBe("A");
    expect(r.groupControlNumber).toBe("123");
    expect(r.transactionSetControlNumber).toBe("0001");
    expect(r.transactionsReceived).toBe(1);
    expect(r.transactionsAccepted).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it("captures per-segment errors on a rejected ack", () => {
    const r = parse999(REJECTED_999);
    expect(r.disposition).toBe("R");
    expect(r.transactionsAccepted).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.segmentId).toBe("NM1");
    // IK403 syntax error code — "7" = invalid code value
    expect(r.errors[0]!.errorCode).toBe("7");
    // IK402 data element reference — "66" = NM109 per X12 dictionary
    expect(r.errors[0]!.elementReferenceNumber).toBe("66");
    expect(r.errors[0]!.errorText).toContain("NM109");
  });
});
