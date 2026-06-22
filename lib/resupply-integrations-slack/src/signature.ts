// Slack request signing verification.
//
// Slack signs every inbound request (interactivity payloads, slash
// commands, Events API) with HMAC-SHA256 over `v0:{timestamp}:{rawBody}`
// keyed by the app signing secret. The hex digest, prefixed `v0=`, is sent
// in the `X-Slack-Signature` header alongside `X-Slack-Request-Timestamp`.
//
// We verify over the EXACT raw bytes (Slack interactivity is
// form-urlencoded, so re-serializing a parsed body would not match), reject
// stale timestamps to defeat replay, and compare with a constant-time
// digest comparison. Mirrors the SendGrid/Twilio webhook posture used
// elsewhere in the codebase.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySlackSignatureInput {
  signingSecret: string;
  /** Value of the `X-Slack-Signature` header (e.g. "v0=abc123…"). */
  signatureHeader: string | undefined | null;
  /** Value of the `X-Slack-Request-Timestamp` header (unix seconds). */
  timestampHeader: string | undefined | null;
  /** The exact raw request body bytes the signature was computed over. */
  rawBody: string | Buffer;
  /** Clock for the replay window; defaults to Date.now(). Injectable for tests. */
  nowMs?: number;
  /** Replay tolerance in seconds (default 300 = 5 minutes, per Slack docs). */
  toleranceSeconds?: number;
}

/**
 * Returns true iff the request carries a valid, in-window Slack signature.
 * Never throws — a malformed header / missing field returns false.
 */
export function verifySlackSignature(
  input: VerifySlackSignatureInput,
): boolean {
  const {
    signingSecret,
    signatureHeader,
    timestampHeader,
    rawBody,
    nowMs = Date.now(),
    toleranceSeconds = 300,
  } = input;

  if (!signingSecret || !signatureHeader || !timestampHeader) return false;

  // Timestamp must be a recent unix-seconds integer. Reject anything
  // outside ±tolerance (stale = replay; far-future = spoofed clock).
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) return false;
  const skewSeconds = Math.abs(nowMs / 1000 - timestamp);
  if (skewSeconds > toleranceSeconds) return false;

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const base = `v0:${timestamp}:${body}`;
  const expected =
    "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex");

  // Constant-time compare. Bail before timingSafeEqual if lengths differ
  // (it throws on unequal-length buffers).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
