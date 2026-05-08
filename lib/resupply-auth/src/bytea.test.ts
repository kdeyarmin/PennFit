import { describe, expect, it } from "vitest";

import {
  bufferToHexBytea,
  bufferToHexByteaOrNull,
  hexByteaToBuffer,
  hexByteaToBufferOrNull,
} from "./bytea.js";

describe("bytea hex encoding", () => {
  it("round-trips the full byte range (0x00 — 0xff)", () => {
    const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const encoded = bufferToHexBytea(buf);
    expect(encoded.startsWith("\\x")).toBe(true);
    expect(encoded.length).toBe(2 + 256 * 2);
    const decoded = hexByteaToBuffer(encoded);
    expect(decoded.equals(buf)).toBe(true);
  });

  it("round-trips a 32-byte token-shaped buffer", () => {
    const buf = Buffer.from(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "hex",
    );
    expect(buf.length).toBe(32);
    const decoded = hexByteaToBuffer(bufferToHexBytea(buf));
    expect(decoded.equals(buf)).toBe(true);
  });

  it("round-trips empty buffer", () => {
    const buf = Buffer.alloc(0);
    expect(bufferToHexBytea(buf)).toBe("\\x");
    expect(hexByteaToBuffer("\\x").length).toBe(0);
  });

  it("rejects strings missing the \\x prefix", () => {
    expect(() => hexByteaToBuffer("68656c6c6f")).toThrow(/prefix/);
    expect(() => hexByteaToBuffer("0x68656c6c6f")).toThrow(/prefix/);
    expect(() => hexByteaToBuffer("")).toThrow(/prefix/);
  });

  it("nullable variants pass through null", () => {
    expect(bufferToHexByteaOrNull(null)).toBeNull();
    expect(hexByteaToBufferOrNull(null)).toBeNull();
    const buf = Buffer.from([1, 2, 3]);
    expect(bufferToHexByteaOrNull(buf)).toBe("\\x010203");
    expect(hexByteaToBufferOrNull("\\x010203")?.equals(buf)).toBe(true);
  });
});
