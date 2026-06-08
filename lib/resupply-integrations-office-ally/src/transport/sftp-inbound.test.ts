import { describe, expect, it } from "vitest";

import { classifyEdiPayload } from "./sftp-inbound";

describe("classifyEdiPayload", () => {
  it("classifies a 999 by the ST*999 sentinel", () => {
    const x = `ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*PENNPAPS01     *260519*1437*^*00501*000000124*0*P*:~GS*FA*OFFCLY*PENNPAPS01*20260519*1437*124*X*005010X231A1~ST*999*0001~AK9*A*1*1*1~SE*3*0001~GE*1*124~IEA*1*000000124~`;
    expect(classifyEdiPayload(x)).toBe("999");
  });
  it("classifies a 277CA (X214 acknowledgement) by version", () => {
    const x = `ISA*00*...*:~GS*HN*OFFCLY*PENNPAPS01*20260519*1437*200*X*005010X214~ST*277*0001~SE*1*0001~GE*1*200~IEA*1*000000200~`;
    expect(classifyEdiPayload(x)).toBe("277ca");
  });
  it("classifies a 277 claim-status response (X212) distinctly", () => {
    const x = `ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*PENNPAPS01     *260519*1437*^*00501*000000201*0*P*:~GS*HN*OFFCLY*PENNPAPS01*20260519*1437*201*X*005010X212~ST*277*0001*005010X212~SE*2*0001~GE*1*201~IEA*1*000000201~`;
    expect(classifyEdiPayload(x)).toBe("277");
  });
  it("classifies an 835 by the ST*835 sentinel", () => {
    const x = `ISA*00*...*:~GS*HP*HIGHMARK01*PENNPAPS01*20260519*1437*123*X*005010X221A1~ST*835*0001~SE*1*0001~GE*1*123~IEA*1*000000123~`;
    expect(classifyEdiPayload(x)).toBe("835");
  });
  it("returns 'unknown' for non-ISA payloads", () => {
    expect(classifyEdiPayload("hello world")).toBe("unknown");
    expect(classifyEdiPayload("")).toBe("unknown");
  });
  it("classifies a 271 by the ST*271 sentinel", () => {
    const x = `ISA*00*...*:~GS*HB*HIGHMARK01*PENNPAPS01*20260519*1437*1*X*005010X279A1~ST*271*0001~SE*1*0001~GE*1*1~IEA*1*1~`;
    expect(classifyEdiPayload(x)).toBe("271");
  });
  it("returns 'unknown' for unrecognised ST", () => {
    const x = `ISA*00*...*:~GS*ZZ*X*Y*20260519*1437*1*X*005010X*~ST*820*0001~`;
    expect(classifyEdiPayload(x)).toBe("unknown");
  });
});
