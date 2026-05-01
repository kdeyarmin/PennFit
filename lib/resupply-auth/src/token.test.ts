import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  TOKEN_BYTES,
  TOKEN_STRING_LENGTH,
  hashToken,
  hashesEqual,
  issueToken,
} from "./token";

describe("issueToken", () => {
  it("produces a base64url string of the expected length", () => {
    const { raw } = issueToken();
    expect(raw).toHaveLength(TOKEN_STRING_LENGTH);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("produces a 32-byte hash matching sha256 of the raw bytes", () => {
    const { raw, hash } = issueToken();
    const decoded = Buffer.from(raw, "base64url");
    expect(decoded.length).toBe(TOKEN_BYTES);
    expect(hash.equals(createHash("sha256").update(decoded).digest())).toBe(
      true,
    );
  });

  it("issues distinct tokens on every call", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tokens.add(issueToken().raw);
    }
    expect(tokens.size).toBe(1000);
  });
});

describe("hashToken", () => {
  it("round-trips with issueToken", () => {
    const { raw, hash } = issueToken();
    const fromRaw = hashToken(raw);
    expect(fromRaw).not.toBeNull();
    expect(fromRaw!.equals(hash)).toBe(true);
  });

  it("returns null for tokens of the wrong length", () => {
    expect(hashToken("short")).toBeNull();
    expect(hashToken("a".repeat(TOKEN_STRING_LENGTH + 1))).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(hashToken(undefined as unknown as string)).toBeNull();
    expect(hashToken(null as unknown as string)).toBeNull();
    expect(hashToken(12345 as unknown as string)).toBeNull();
  });
});

describe("hashesEqual", () => {
  it("returns true for identical buffers", () => {
    const a = Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const b = Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(hashesEqual(a, b)).toBe(true);
  });

  it("returns false for different buffers", () => {
    const a = Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const b = Buffer.from("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(hashesEqual(a, b)).toBe(false);
  });

  it("returns false when lengths differ (no throw)", () => {
    expect(hashesEqual(Buffer.from("a"), Buffer.from("aa"))).toBe(false);
  });
});
