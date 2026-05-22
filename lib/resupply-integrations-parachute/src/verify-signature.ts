// HMAC-SHA256 signature verification for Parachute Health webhooks.
//
// Header format (mirrors the de-facto standard used by Stripe /
// Segment / Shopify):
//
//   x-parachute-signature: t=<unix_seconds>,v1=<hex_hmac>
//
// We compute hmac_sha256(<signingSecret>, `${t}.${rawBody}`) and
// compare in constant time against v1. A 5-minute replay window
// rejects stale deliveries.
//
// Returns a tagged-union outcome so callers can branch on the
// specific failure (and emit different audit events for each).

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: "missing_header" }
  | { ok: false; reason: "malformed_header" }
  | { ok: false; reason: "stale_timestamp" }
  | { ok: false; reason: "bad_signature" };

interface VerifyInput {
  /**
   * Raw HTTP body bytes — must be the exact bytes the sender hashed
   * over, NOT a re-serialised JSON.parse(...).
   */
  rawBody: string;
  /** Value of the x-parachute-signature header. */
  signatureHeader: string | null | undefined;
  signingSecret: string;
  /** Defaults to Date.now / 1000. Tests inject a fixed clock. */
  nowSeconds?: number;
  /** Defaults to 300s. */
  toleranceSeconds?: number;
}

export function verifyParachuteSignature(input: VerifyInput): VerifyOutcome {
  const header = input.signatureHeader;
  if (typeof header !== "string" || header.length === 0) {
    return { ok: false, reason: "missing_header" };
  }
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: number | null = null;
  let signatureHex: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "t") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) timestamp = Math.trunc(n);
    } else if (k === "v1") {
      // 64 hex chars = 32 bytes = SHA-256 output. Anything else is
      // structurally invalid.
      if (/^[0-9a-f]{64}$/i.test(v)) signatureHex = v.toLowerCase();
    }
  }
  if (timestamp === null || signatureHex === null) {
    return { ok: false, reason: "malformed_header" };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = createHmac("sha256", input.signingSecret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest("hex");
  // timingSafeEqual requires identical buffer lengths; the regex
  // above guarantees signatureHex is 64 hex chars so this is safe.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHex, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * Convenience helper for the sending side. Used in tests + by the
 * Phase 5 outbound status callbacks.
 */
export function signParachutePayload(
  rawBody: string,
  signingSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const t = Math.trunc(nowSeconds);
  const sig = createHmac("sha256", signingSecret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return `t=${t},v1=${sig}`;
}
