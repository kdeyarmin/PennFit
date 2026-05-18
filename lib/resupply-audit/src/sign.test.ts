// Pure unit tests for the audit HMAC chain helpers in ./sign.
//
// No DB, no env required at module load — every test that needs a
// key registers one via `registerAuditHmacKeyForTesting` and clears
// it in afterEach so suites don't leak state.

import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIT_HMAC_KEY_ENV,
  AuditHmacKeyError,
  canonicalJson,
  registerAuditHmacKeyForTesting,
  requireAuditHmacKey,
  signAuditRow,
  type AuditChainContent,
} from "./sign";

afterEach(() => {
  registerAuditHmacKeyForTesting(null);
});

describe("canonicalJson", () => {
  it("sorts object keys", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(`{"a":1,"b":2}`);
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe(`[3,1,2]`);
  });

  it("recurses into nested objects/arrays", () => {
    expect(
      canonicalJson({ z: [{ b: 2, a: 1 }], y: { d: 4, c: 3 } }),
    ).toBe(`{"y":{"c":3,"d":4},"z":[{"a":1,"b":2}]}`);
  });

  it("handles null and primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("hi")).toBe(`"hi"`);
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
  });

  it("produces the same output regardless of insertion order", () => {
    const a = canonicalJson({ a: 1, b: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });
});

describe("signAuditRow", () => {
  const key = Buffer.alloc(32, 0x42);
  const content: AuditChainContent = {
    chain_seq: 1,
    operator_email: "ops@example.com",
    operator_user_id: "user_x",
    action: "patient.view",
    target_table: "patients",
    target_id: "00000000-0000-0000-0000-000000000001",
    metadata: { _runTag: "demo" },
    ip: "127.0.0.1",
    user_agent: "vitest",
  };

  it("is deterministic for the same input", () => {
    const a = signAuditRow(key, null, content);
    const b = signAuditRow(key, null, content);
    expect(a).toBe(b);
  });

  it("returns a base64 string of the expected length (sha256 -> 44 chars)", () => {
    const sig = signAuditRow(key, null, content);
    expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(sig, "base64").length).toBe(32);
  });

  it("differs when the predecessor signature changes", () => {
    const a = signAuditRow(key, null, content);
    const b = signAuditRow(key, "some-other-prev", content);
    expect(a).not.toBe(b);
  });

  it("differs when chain_seq changes (position is committed)", () => {
    const a = signAuditRow(key, null, content);
    const b = signAuditRow(key, null, { ...content, chain_seq: 2 });
    expect(a).not.toBe(b);
  });

  it("differs when any content field changes", () => {
    const a = signAuditRow(key, null, content);
    const b = signAuditRow(key, null, { ...content, action: "patient.edit" });
    expect(a).not.toBe(b);
  });

  it("is insensitive to metadata key insertion order (canonical)", () => {
    const a = signAuditRow(key, null, {
      ...content,
      metadata: { a: 1, b: 2 },
    });
    const b = signAuditRow(key, null, {
      ...content,
      metadata: { b: 2, a: 1 },
    });
    expect(a).toBe(b);
  });

  it("differs with a different key", () => {
    const otherKey = Buffer.alloc(32, 0x43);
    const a = signAuditRow(key, null, content);
    const b = signAuditRow(otherKey, null, content);
    expect(a).not.toBe(b);
  });
});

describe("requireAuditHmacKey", () => {
  it("returns the registered test key when set", () => {
    const key = Buffer.alloc(32, 0xaa);
    registerAuditHmacKeyForTesting(key);
    expect(requireAuditHmacKey()).toBe(key);
  });

  it("falls back to the env var when no test key is set", () => {
    const prior = process.env[AUDIT_HMAC_KEY_ENV];
    process.env[AUDIT_HMAC_KEY_ENV] = Buffer.alloc(32, 0xbb).toString("base64");
    try {
      const key = requireAuditHmacKey();
      expect(key.length).toBe(32);
      expect(key.every((b) => b === 0xbb)).toBe(true);
    } finally {
      if (prior === undefined) delete process.env[AUDIT_HMAC_KEY_ENV];
      else process.env[AUDIT_HMAC_KEY_ENV] = prior;
    }
  });

  it("throws AuditHmacKeyError when neither test key nor env is set", () => {
    const prior = process.env[AUDIT_HMAC_KEY_ENV];
    delete process.env[AUDIT_HMAC_KEY_ENV];
    try {
      expect(() => requireAuditHmacKey()).toThrow(AuditHmacKeyError);
    } finally {
      if (prior !== undefined) process.env[AUDIT_HMAC_KEY_ENV] = prior;
    }
  });

  it("throws AuditHmacKeyError when env key decodes to fewer than 32 bytes", () => {
    const prior = process.env[AUDIT_HMAC_KEY_ENV];
    // 16 bytes is half the required entropy.
    process.env[AUDIT_HMAC_KEY_ENV] = Buffer.alloc(16, 0x01).toString("base64");
    try {
      expect(() => requireAuditHmacKey()).toThrow(AuditHmacKeyError);
    } finally {
      if (prior === undefined) delete process.env[AUDIT_HMAC_KEY_ENV];
      else process.env[AUDIT_HMAC_KEY_ENV] = prior;
    }
  });

  it("throws AuditHmacKeyError when env key is not strict base64 (e.g. hex)", () => {
    const prior = process.env[AUDIT_HMAC_KEY_ENV];
    // 64 hex chars = 32 bytes of would-be entropy, but '0123456789abcdef'
    // contains characters outside the strict base64 alphabet ('a'–'f'
    // are fine, but hex strings won't round-trip through encode/decode
    // — and a string with non-base64 chars must be rejected outright).
    // Use a string that has '_' which is definitely not base64.
    process.env[AUDIT_HMAC_KEY_ENV] = "a".repeat(40) + "_b";
    try {
      expect(() => requireAuditHmacKey()).toThrow(AuditHmacKeyError);
    } finally {
      if (prior === undefined) delete process.env[AUDIT_HMAC_KEY_ENV];
      else process.env[AUDIT_HMAC_KEY_ENV] = prior;
    }
  });

  it("throws AuditHmacKeyError when env key isn't a base64 quantum (no padding, wrong length)", () => {
    const prior = process.env[AUDIT_HMAC_KEY_ENV];
    // 43 A's: matches the strict-base64 regex, decodes to 32 bytes
    // (so the length floor passes), but re-encoding adds an `=` so
    // the round-trip check fires. Realistic shape for an operator
    // who omitted the padding when pasting into a secrets manager.
    process.env[AUDIT_HMAC_KEY_ENV] = "A".repeat(43);
    try {
      expect(() => requireAuditHmacKey()).toThrow(AuditHmacKeyError);
    } finally {
      if (prior === undefined) delete process.env[AUDIT_HMAC_KEY_ENV];
      else process.env[AUDIT_HMAC_KEY_ENV] = prior;
    }
  });
});
