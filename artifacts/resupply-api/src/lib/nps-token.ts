// HMAC-SHA256 signed tokens for the post-delivery NPS capture link.
//
// The shop-order.delivery-followup email includes 11 "tap your
// rating" links (0..10), each pointing at /nps?orderId=&score=&t=.
// `t` is the signed token that:
//
//   1. Binds the rating to the specific order id (so the same token
//      can't be replayed against a different order).
//   2. Carries a 30-day TTL — comfortably wider than the
//      delivery-follow-up window so a customer who opens their email
//      a week late still gets to respond.
//
// Uses RESUPPLY_LINK_HMAC_KEY, the existing key already in use by
// the fax-document and reminder-link tokens. No new secret.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

interface NpsTokenPayload {
  /** shop_orders.id this rating belongs to. */
  o: string;
  /** Score 0..10 the link encodes. */
  s: number;
  /** Expiry as Unix seconds. */
  e: number;
}

/** 30 days — wider than the dispatcher's 3-14d window so a late
 *  email open still gets to respond. */
const DEFAULT_TTL_SECONDS = 30 * 86_400;

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) return null;
  const pad = (4 - (s.length % 4)) % 4;
  const standard = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  try {
    return Buffer.from(standard, "base64");
  } catch {
    return null;
  }
}

function hmacSign(payloadEncoded: string): Buffer {
  return createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
}

export function signNpsToken(
  orderId: string,
  score: number,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  if (score < 0 || score > 10 || !Number.isInteger(score)) {
    throw new Error("nps score must be an integer in 0..10");
  }
  const payload: NpsTokenPayload = {
    o: orderId,
    s: score,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type VerifyNpsTokenResult =
  | { valid: true; orderId: string; score: number }
  | { valid: false };

export function verifyNpsToken(token: string): VerifyNpsTokenResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) return { valid: false };

  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);

  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false };

  const expected = hmacSign(payloadEncoded);
  if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) {
    return { valid: false };
  }

  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { valid: false };
  }

  const p = parsed as NpsTokenPayload;
  if (
    !p ||
    typeof p.o !== "string" ||
    !p.o ||
    typeof p.s !== "number" ||
    !Number.isInteger(p.s) ||
    p.s < 0 ||
    p.s > 10 ||
    typeof p.e !== "number"
  ) {
    return { valid: false };
  }

  if (p.e <= Math.floor(Date.now() / 1000)) return { valid: false };

  return { valid: true, orderId: p.o, score: p.s };
}
