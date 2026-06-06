// Tests for the patient-packet signing token. Stub getLinkHmacKey so
// tests don't need RESUPPLY_LINK_HMAC_KEY in env; sign + verify share
// the same mocked key so round-trips work.

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-patient-packet-hmac-key-0123456789", "utf8"),
}));

import {
  signPatientPacketToken,
  verifyPatientPacketToken,
} from "./patient-packet-token";

describe("patient-packet token", () => {
  it("round-trips packet id + link version", () => {
    const token = signPatientPacketToken("packet-1", 3);
    expect(verifyPatientPacketToken(token)).toEqual({
      valid: true,
      packetId: "packet-1",
      linkVersion: 3,
    });
  });

  it("rejects a tampered payload", () => {
    const token = signPatientPacketToken("packet-1", 1);
    const [payload, sig] = token.split(".");
    const tampered = `${payload}x.${sig}`;
    expect(verifyPatientPacketToken(tampered)).toEqual({ valid: false });
  });

  it("rejects a tampered signature", () => {
    const token = signPatientPacketToken("packet-1", 1);
    const [payload] = token.split(".");
    expect(verifyPatientPacketToken(`${payload}.AAAA`)).toEqual({
      valid: false,
    });
  });

  it("rejects an expired token", () => {
    const token = signPatientPacketToken("packet-1", 1, -10);
    expect(verifyPatientPacketToken(token)).toEqual({ valid: false });
  });

  it("rejects malformed tokens", () => {
    expect(verifyPatientPacketToken("")).toEqual({ valid: false });
    expect(verifyPatientPacketToken("nodot")).toEqual({ valid: false });
    expect(verifyPatientPacketToken(".")).toEqual({ valid: false });
  });
});
