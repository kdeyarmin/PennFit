// Unit tests for clinician-share-token.ts. Mirrors the fax-doc
// token suite — same primitive, different payload semantics.

import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8"),
}));

import {
  signClinicianShareToken,
  verifyClinicianShareToken,
} from "./clinician-share-token";

describe("signClinicianShareToken / verifyClinicianShareToken", () => {
  it("round-trips a valid token + returns the share row id", () => {
    const { token } = signClinicianShareToken("share-uuid-1");
    const result = verifyClinicianShareToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.shareRowId).toBe("share-uuid-1");
  });

  it("returns expiresAt 30 days out by default", () => {
    const before = Date.now();
    const { expiresAt } = signClinicianShareToken("share-uuid-1");
    const expiryMs = Date.parse(expiresAt);
    // Within a couple seconds of (now + 30d)
    expect(expiryMs).toBeGreaterThan(before + 29 * 24 * 60 * 60 * 1000);
    expect(expiryMs).toBeLessThan(before + 31 * 24 * 60 * 60 * 1000);
  });

  it("honours a custom TTL", () => {
    const before = Date.now();
    const { expiresAt } = signClinicianShareToken("share-uuid-1", 3600);
    const expiryMs = Date.parse(expiresAt);
    expect(expiryMs).toBeGreaterThan(before + 3500 * 1000);
    expect(expiryMs).toBeLessThan(before + 3700 * 1000);
  });

  it("rejects an expired token", () => {
    const { token } = signClinicianShareToken("share-uuid-1", -10);
    expect(verifyClinicianShareToken(token).valid).toBe(false);
  });

  it("rejects a token with a tampered signature", () => {
    const { token } = signClinicianShareToken("share-uuid-1");
    const idx = token.indexOf(".");
    const tampered = `${token.slice(0, idx)}.AAAAAAAA${token.slice(idx + 9)}`;
    expect(verifyClinicianShareToken(tampered).valid).toBe(false);
  });

  it("rejects a token with a tampered payload", () => {
    const { token } = signClinicianShareToken("share-uuid-1");
    const tampered = `Z${token.slice(1)}`;
    expect(verifyClinicianShareToken(tampered).valid).toBe(false);
  });

  it("rejects a token with no separator", () => {
    expect(verifyClinicianShareToken("notatoken").valid).toBe(false);
  });

  it("rejects a token with leading/trailing dot", () => {
    expect(verifyClinicianShareToken(".sigonly").valid).toBe(false);
    expect(verifyClinicianShareToken("payloadonly.").valid).toBe(false);
  });

  it("rejects a token with invalid base64url chars", () => {
    expect(verifyClinicianShareToken("???.???").valid).toBe(false);
  });
});
