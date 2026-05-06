// Unit tests for fax-document-token.ts
//
// Coverage:
//   * signFaxDocumentToken produces a token verifiable by verifyFaxDocumentToken
//   * Custom TTL is honoured
//   * Expired token returns { valid: false }
//   * Signature tampering returns { valid: false }
//   * Payload tampering returns { valid: false }
//   * Malformed token (no dot separator) returns { valid: false }
//   * Bad base64url characters return { valid: false }
//   * Missing id field returns { valid: false }
//   * Non-numeric expiry returns { valid: false }
//   * Empty outreach id returns { valid: false }
//   * Token with trailing dot / leading dot returns { valid: false }

import { createHmac } from "node:crypto";

import { describe, it, expect, vi } from "vitest";

// Stub getLinkHmacKey so tests don't need RESUPPLY_LINK_HMAC_KEY in env.
vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () => Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8"),
}));

import {
  signFaxDocumentToken,
  verifyFaxDocumentToken,
} from "./fax-document-token";

describe("signFaxDocumentToken / verifyFaxDocumentToken — round-trip", () => {
  it("round-trips a valid token", () => {
    const token = signFaxDocumentToken("outreach-uuid-1");
    const result = verifyFaxDocumentToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.outreachId).toBe("outreach-uuid-1");
  });

  it("embeds the outreach ID correctly", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const token = signFaxDocumentToken(id);
    const result = verifyFaxDocumentToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.outreachId).toBe(id);
  });

  it("uses a custom TTL when provided", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Sign with 2-second TTL, advance time by 1 second — should still be valid.
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const token = signFaxDocumentToken("out-ttl", 2);
    vi.advanceTimersByTime(1000);
    const result = verifyFaxDocumentToken(token);
    expect(result.valid).toBe(true);
    vi.useRealTimers();
  });
});

describe("verifyFaxDocumentToken — expiry", () => {
  it("rejects an expired token (past expiry)", () => {
    vi.useFakeTimers();
    const nowSec = Math.floor(Date.now() / 1000);
    vi.setSystemTime(nowSec * 1000);
    const token = signFaxDocumentToken("out-expired", 1); // 1 second TTL
    vi.advanceTimersByTime(2000); // advance 2 seconds past expiry
    const result = verifyFaxDocumentToken(token);
    expect(result.valid).toBe(false);
    vi.useRealTimers();
  });

  it("rejects a token that expires exactly at the current second", () => {
    vi.useFakeTimers();
    const nowSec = Math.floor(Date.now() / 1000);
    vi.setSystemTime(nowSec * 1000);
    const token = signFaxDocumentToken("out-boundary", 0); // expires immediately
    // Don't advance time — expiry == now, should be invalid (strict <)
    const result = verifyFaxDocumentToken(token);
    expect(result.valid).toBe(false);
    vi.useRealTimers();
  });
});

describe("verifyFaxDocumentToken — signature checks", () => {
  it("rejects a token with a tampered signature", () => {
    const token = signFaxDocumentToken("out-1");
    const [payload] = token.split(".");
    const result = verifyFaxDocumentToken(`${payload}.bad-sig-xxxx`);
    expect(result.valid).toBe(false);
  });

  it("rejects a token with a tampered payload", () => {
    const token = signFaxDocumentToken("out-1");
    const parts = token.split(".");
    // Replace payload with a different base64url value
    const fakePayload = Buffer.from(
      JSON.stringify({ id: "evil-id", e: Math.floor(Date.now() / 1000) + 9999 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = verifyFaxDocumentToken(`${fakePayload}.${parts[1]}`);
    expect(result.valid).toBe(false);
  });
});

describe("verifyFaxDocumentToken — malformed tokens", () => {
  it("rejects a token with no dot separator", () => {
    expect(verifyFaxDocumentToken("nodothere").valid).toBe(false);
  });

  it("rejects a token with a leading dot", () => {
    expect(verifyFaxDocumentToken(".sigonly").valid).toBe(false);
  });

  it("rejects a token with a trailing dot", () => {
    expect(verifyFaxDocumentToken("payloadonly.").valid).toBe(false);
  });

  it("rejects a token with invalid base64url characters in sig", () => {
    const token = signFaxDocumentToken("out-2");
    const [payload] = token.split(".");
    // Inject a character illegal in base64url
    expect(verifyFaxDocumentToken(`${payload}.!!invalid!!`).valid).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(verifyFaxDocumentToken("").valid).toBe(false);
  });
});

describe("verifyFaxDocumentToken — payload structure", () => {
  it("rejects a payload where id is missing", () => {
    // Build a token with a valid signature but a payload missing 'id'.
    // We can't easily sign with the mocked key from outside, so we
    // test this via a correctly-signed token with a patched payload.
    // Strategy: sign a normal token, then craft a payload-only tamper
    // by using a sub-module-level approach — easier: test the effect
    // by checking that non-string id fails. Use fake payload + real signing:
    // Since getLinkHmacKey is mocked, we can import createHmac ourselves.
    const key = Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8");
    const payload = Buffer.from(JSON.stringify({ e: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const sig = createHmac("sha256", key).update(payload, "utf8").digest("base64url");
    expect(verifyFaxDocumentToken(`${payload}.${sig}`).valid).toBe(false);
  });

  it("rejects a payload where expiry is not a number", () => {
    const key = Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8");
    const payload = Buffer.from(JSON.stringify({ id: "out-1", e: "not-a-number" })).toString("base64url");
    const sig = createHmac("sha256", key).update(payload, "utf8").digest("base64url");
    expect(verifyFaxDocumentToken(`${payload}.${sig}`).valid).toBe(false);
  });

  it("rejects a payload where id is an empty string", () => {
    const key = Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8");
    const payload = Buffer.from(JSON.stringify({ id: "", e: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const sig = createHmac("sha256", key).update(payload, "utf8").digest("base64url");
    expect(verifyFaxDocumentToken(`${payload}.${sig}`).valid).toBe(false);
  });
});
