// Tests for the mask-fit survey token (RT #22a). Stub getLinkHmacKey so
// tests don't need RESUPPLY_LINK_HMAC_KEY in env; sign + verify share
// the same mocked key so round-trips work.

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-mask-fit-hmac-key-0123456789", "utf8"),
}));

import {
  signMaskFitToken,
  verifyMaskFitToken,
  MASK_FIT_OUTCOMES,
} from "./mask-fit-token";

describe("mask-fit token", () => {
  it("round-trips each outcome", () => {
    for (const outcome of MASK_FIT_OUTCOMES) {
      const token = signMaskFitToken("order-1", outcome);
      const v = verifyMaskFitToken(token);
      expect(v).toEqual({ valid: true, orderId: "order-1", outcome });
    }
  });

  it("rejects a tampered payload", () => {
    const token = signMaskFitToken("order-1", "leaking");
    const [payload, sig] = token.split(".");
    // flip the order id in the payload, keep the old signature
    const tampered = `${Buffer.from(
      '{"o":"order-2","f":"leaking","e":9999999999}',
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "")}.${sig}`;
    expect(verifyMaskFitToken(tampered).valid).toBe(false);
    expect(payload).toBeTruthy();
  });

  it("rejects an expired token", () => {
    const token = signMaskFitToken("order-1", "good", -10); // already expired
    expect(verifyMaskFitToken(token).valid).toBe(false);
  });

  it("rejects a malformed token", () => {
    expect(verifyMaskFitToken("not-a-token").valid).toBe(false);
    expect(verifyMaskFitToken("").valid).toBe(false);
    expect(verifyMaskFitToken(".").valid).toBe(false);
  });

  it("refuses to sign an invalid outcome", () => {
    expect(() => signMaskFitToken("order-1", "broken" as never)).toThrow();
  });
});
