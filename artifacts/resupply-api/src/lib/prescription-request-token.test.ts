import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8"),
}));

import {
  signPrescriptionRequestToken,
  verifyPrescriptionRequestToken,
} from "./prescription-request-token";

describe("signPrescriptionRequestToken / verifyPrescriptionRequestToken", () => {
  it("round-trips a valid token", () => {
    const token = signPrescriptionRequestToken("packet-uuid-1");
    const result = verifyPrescriptionRequestToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.packetId).toBe("packet-uuid-1");
  });

  it("honours a custom TTL", () => {
    const token = signPrescriptionRequestToken("p1", 3600);
    expect(verifyPrescriptionRequestToken(token).valid).toBe(true);
  });

  it("rejects an expired token", () => {
    const token = signPrescriptionRequestToken("p1", -10);
    expect(verifyPrescriptionRequestToken(token).valid).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = signPrescriptionRequestToken("p1");
    const idx = token.indexOf(".");
    const tampered = `${token.slice(0, idx)}.AAAAAAAA${token.slice(idx + 9)}`;
    expect(verifyPrescriptionRequestToken(tampered).valid).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = signPrescriptionRequestToken("p1");
    const tampered = `Z${token.slice(1)}`;
    expect(verifyPrescriptionRequestToken(tampered).valid).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifyPrescriptionRequestToken("nope").valid).toBe(false);
    expect(verifyPrescriptionRequestToken(".sig").valid).toBe(false);
    expect(verifyPrescriptionRequestToken("payload.").valid).toBe(false);
  });

  it("rejects a token with invalid base64url characters", () => {
    expect(verifyPrescriptionRequestToken("???.???").valid).toBe(false);
  });
});
