import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  signLinkToken,
  verifyLinkToken,
  LINK_ACTIONS,
} from "./signed-link-tokens";

const KEY_ENV = "RESUPPLY_LINK_HMAC_KEY";

describe("signLinkToken / verifyLinkToken", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env[KEY_ENV];
    // 32-byte base64-encoded key — matches the preflight contract
    // (`requireBase64Bytes("RESUPPLY_LINK_HMAC_KEY", 32)`) so test
    // and production agree on what a "valid" key looks like.
    process.env[KEY_ENV] = Buffer.alloc(32, 0x11).toString("base64");
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = savedKey;
  });

  it("round-trips a valid token", () => {
    const now = new Date("2026-04-28T12:00:00Z");
    const expiresAt = new Date("2026-05-05T12:00:00Z");
    const token = signLinkToken({
      conversationId: "conv-123",
      action: "confirm",
      expiresAt,
      now,
    });
    const result = verifyLinkToken(token, { now });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.conversationId).toBe("conv-123");
    expect(result.action).toBe("confirm");
    expect(result.expiresAt.toISOString()).toBe(expiresAt.toISOString());
  });

  it("uses a default 7-day TTL when expiresAt is omitted", () => {
    const now = new Date("2026-04-28T12:00:00Z");
    const token = signLinkToken({
      conversationId: "conv-123",
      action: "confirm",
      now,
    });
    const result = verifyLinkToken(token, { now });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const drift = Math.abs(
      result.expiresAt.getTime() - (now.getTime() + sevenDaysMs),
    );
    expect(drift).toBeLessThan(2_000);
  });

  it("rejects a tampered payload", () => {
    const token = signLinkToken({
      conversationId: "conv-123",
      action: "confirm",
    });
    const [payload, sig] = token.split(".");
    // Replace one character in the payload — base64url is canonical so
    // any change shifts the bytes the HMAC was computed over.
    const corrupted =
      (payload!.charAt(0) === "A" ? "B" : "A") + payload!.slice(1);
    const result = verifyLinkToken(`${corrupted}.${sig}`);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects a tampered signature", () => {
    const token = signLinkToken({
      conversationId: "conv-123",
      action: "confirm",
    });
    const [payload, sig] = token.split(".");
    const corrupted = (sig!.charAt(0) === "A" ? "B" : "A") + sig!.slice(1);
    const result = verifyLinkToken(`${payload}.${corrupted}`);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects an expired token", () => {
    const issued = new Date("2026-04-28T12:00:00Z");
    const expiresAt = new Date("2026-04-28T13:00:00Z");
    const token = signLinkToken({
      conversationId: "conv-123",
      action: "confirm",
      expiresAt,
      now: issued,
    });
    const past = new Date("2026-04-28T14:00:00Z");
    const result = verifyLinkToken(token, { now: past });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("expired");
  });

  it("rejects an empty/null/junk token shape", () => {
    expect(verifyLinkToken("").valid).toBe(false);
    expect(verifyLinkToken(null).valid).toBe(false);
    expect(verifyLinkToken("notoken").valid).toBe(false);
    expect(verifyLinkToken(".").valid).toBe(false);
    expect(verifyLinkToken("a.").valid).toBe(false);
    expect(verifyLinkToken(".b").valid).toBe(false);
    expect(verifyLinkToken("aaa.bbb").valid).toBe(false);
  });

  it("rejects tokens with non-base64url characters", () => {
    expect(verifyLinkToken("invalid$!.bad@@").valid).toBe(false);
  });

  it("produces different tokens under different keys", () => {
    process.env[KEY_ENV] = Buffer.alloc(32, 0x22).toString("base64");
    const a = signLinkToken({
      conversationId: "conv-123",
      action: "confirm",
    });
    process.env[KEY_ENV] = Buffer.alloc(32, 0x33).toString("base64");
    const b = signLinkToken({
      conversationId: "conv-123",
      action: "confirm",
    });
    expect(a).not.toBe(b);
    // And cross-verification fails.
    process.env[KEY_ENV] = Buffer.alloc(32, 0x22).toString("base64");
    const r = verifyLinkToken(b);
    expect(r.valid).toBe(false);
  });

  it("throws when signing if HMAC key is unset", () => {
    delete process.env[KEY_ENV];
    expect(() =>
      signLinkToken({ conversationId: "x", action: "confirm" }),
    ).toThrow(/RESUPPLY_LINK_HMAC_KEY/);
  });

  it("returns invalid when verifying if HMAC key is unset", () => {
    const token = signLinkToken({
      conversationId: "x",
      action: "confirm",
    });
    delete process.env[KEY_ENV];
    const result = verifyLinkToken(token);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects unknown action at sign time", () => {
    expect(() =>
      signLinkToken({
        conversationId: "x",
        // @ts-expect-error -- testing runtime guard
        action: "delete-everything",
      }),
    ).toThrow(/unknown action/);
  });

  it("LINK_ACTIONS exhaustively covers confirm/edit/stop", () => {
    expect(LINK_ACTIONS).toEqual(["confirm", "edit", "stop"]);
  });

  it("requires a conversationId", () => {
    expect(() =>
      signLinkToken({ conversationId: "", action: "confirm" }),
    ).toThrow(/conversationId/);
  });

  it("throws when RESUPPLY_LINK_HMAC_KEY is unset", () => {
    delete process.env[KEY_ENV];
    expect(() =>
      signLinkToken({ conversationId: "conv-x", action: "confirm" }),
    ).toThrow(/RESUPPLY_LINK_HMAC_KEY/);
  });
});
