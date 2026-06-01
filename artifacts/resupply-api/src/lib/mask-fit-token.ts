// HMAC-SHA256 signed tokens for the post-delivery mask-fit micro-survey
// link (RT #22a). Mirrors nps-token.ts: the delivery-followup email can
// carry three "tap your result" links (Good fit / Leaking / Uncomfortable),
// each a signed token that:
//
//   1. Binds the outcome to a specific shop_orders id (no replay against
//      another order), and
//   2. Carries a 30-day TTL — wider than the follow-up window so a late
//      email open still gets to respond.
//
// Uses RESUPPLY_LINK_HMAC_KEY (the existing reminder/NPS/fax key). No new
// secret. Pure crypto — unit-tested directly.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

export const MASK_FIT_OUTCOMES = ["good", "leaking", "uncomfortable"] as const;
export type MaskFitOutcome = (typeof MASK_FIT_OUTCOMES)[number];

interface MaskFitTokenPayload {
  /** shop_orders.id this outcome belongs to. */
  o: string;
  /** Fit outcome the link encodes. */
  f: MaskFitOutcome;
  /** Expiry as Unix seconds. */
  e: number;
  /** Optional recommendation-engine mask id, for the #22b tuning signal. */
  m?: string;
}

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

function isOutcome(v: unknown): v is MaskFitOutcome {
  return (
    typeof v === "string" &&
    (MASK_FIT_OUTCOMES as readonly string[]).includes(v)
  );
}

export function signMaskFitToken(
  orderId: string,
  outcome: MaskFitOutcome,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  maskId?: string,
): string {
  if (!isOutcome(outcome)) {
    throw new Error("mask-fit outcome must be good | leaking | uncomfortable");
  }
  const payload: MaskFitTokenPayload = {
    o: orderId,
    f: outcome,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(maskId ? { m: maskId } : {}),
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type VerifyMaskFitTokenResult =
  | {
      valid: true;
      orderId: string;
      outcome: MaskFitOutcome;
      maskId: string | null;
    }
  | { valid: false };

export function verifyMaskFitToken(token: string): VerifyMaskFitTokenResult {
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

  const p = parsed as MaskFitTokenPayload;
  if (
    !p ||
    typeof p.o !== "string" ||
    !p.o ||
    !isOutcome(p.f) ||
    typeof p.e !== "number"
  ) {
    return { valid: false };
  }

  if (p.e <= Math.floor(Date.now() / 1000)) return { valid: false };

  return {
    valid: true,
    orderId: p.o,
    outcome: p.f,
    maskId: typeof p.m === "string" && p.m.length > 0 ? p.m : null,
  };
}
