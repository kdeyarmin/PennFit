// Tests for the CSR-order sign-&-pay token. Stub getLinkHmacKey so
// tests don't need RESUPPLY_LINK_HMAC_KEY in env; sign + verify share
// the same mocked key so round-trips work.

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-csr-order-hmac-key-0123456789abcdef", "utf8"),
}));

import { signCsrOrderToken, verifyCsrOrderToken } from "./token";
import { signPatientPacketToken } from "../patient-packet-token";

describe("csr-order token", () => {
  it("round-trips order id + link version", () => {
    const token = signCsrOrderToken("order-1", 3);
    expect(verifyCsrOrderToken(token)).toEqual({
      valid: true,
      orderRequestId: "order-1",
      linkVersion: 3,
    });
  });

  it("rejects a tampered payload", () => {
    const token = signCsrOrderToken("order-1", 1);
    const [payload, sig] = token.split(".");
    const tampered = `${payload}x.${sig}`;
    expect(verifyCsrOrderToken(tampered)).toEqual({ valid: false });
  });

  it("rejects a tampered signature", () => {
    const token = signCsrOrderToken("order-1", 1);
    const [payload] = token.split(".");
    expect(verifyCsrOrderToken(`${payload}.AAAA`)).toEqual({ valid: false });
  });

  it("rejects an expired token", () => {
    const token = signCsrOrderToken("order-1", 1, -10);
    expect(verifyCsrOrderToken(token)).toEqual({ valid: false });
  });

  it("rejects malformed tokens", () => {
    expect(verifyCsrOrderToken("")).toEqual({ valid: false });
    expect(verifyCsrOrderToken("nodot")).toEqual({ valid: false });
    expect(verifyCsrOrderToken(".")).toEqual({ valid: false });
  });

  it("rejects a token minted for another surface (kind discriminator)", () => {
    // Same key, same primitive — a patient-packet token must NOT
    // verify against the order endpoints.
    const packetToken = signPatientPacketToken("order-1", 1);
    expect(verifyCsrOrderToken(packetToken)).toEqual({ valid: false });
  });
});
