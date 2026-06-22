import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "./signature";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function sign(body: string, timestamp: number, secret = SECRET): string {
  return (
    "v0=" +
    createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")
  );
}

describe("verifySlackSignature", () => {
  const nowMs = 1_700_000_000_000;
  const ts = Math.floor(nowMs / 1000);
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";

  it("accepts a valid, in-window signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signatureHeader: sign(body, ts),
        timestampHeader: String(ts),
        rawBody: body,
        nowMs,
      }),
    ).toBe(true);
  });

  it("accepts a Buffer raw body identically", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signatureHeader: sign(body, ts),
        timestampHeader: String(ts),
        rawBody: Buffer.from(body, "utf8"),
        nowMs,
      }),
    ).toBe(true);
  });

  it("rejects a forged signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signatureHeader: sign(body, ts, "wrong-secret"),
        timestampHeader: String(ts),
        rawBody: body,
        nowMs,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signatureHeader: sign(body, ts),
        timestampHeader: String(ts),
        rawBody: body + "&injected=1",
        nowMs,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay)", () => {
    const staleTs = ts - 60 * 10; // 10 minutes old
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signatureHeader: sign(body, staleTs),
        timestampHeader: String(staleTs),
        rawBody: body,
        nowMs,
      }),
    ).toBe(false);
  });

  it("rejects missing headers / secret without throwing", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signatureHeader: undefined,
        timestampHeader: String(ts),
        rawBody: body,
        nowMs,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        signingSecret: "",
        signatureHeader: sign(body, ts),
        timestampHeader: String(ts),
        rawBody: body,
        nowMs,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signatureHeader: sign(body, ts),
        timestampHeader: "not-a-number",
        rawBody: body,
        nowMs,
      }),
    ).toBe(false);
  });
});
