// HMAC-signed token for the public prescription-request document
// URL. Twilio fetches /rx-request/document/:token immediately after
// dispatch; the token carries the packet row id and a 24h TTL so
// the document remains available for the Twilio retry window
// without ever being permanently public.
//
// Mirrors lib/fax-document-token.ts (same signing primitive +
// shared RESUPPLY_LINK_HMAC_KEY).

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

interface PacketTokenPayload {
  id: string;
  e: number;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours — Twilio retries

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

export function signPrescriptionRequestToken(
  packetId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const payload: PacketTokenPayload = {
    id: packetId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type VerifyPrescriptionRequestTokenResult =
  | { valid: true; packetId: string }
  | { valid: false };

export function verifyPrescriptionRequestToken(
  token: string,
): VerifyPrescriptionRequestTokenResult {
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
  const p = parsed as PacketTokenPayload;
  if (!p || typeof p.id !== "string" || !p.id || typeof p.e !== "number") {
    return { valid: false };
  }
  if (p.e <= Math.floor(Date.now() / 1000)) return { valid: false };
  return { valid: true, packetId: p.id };
}
