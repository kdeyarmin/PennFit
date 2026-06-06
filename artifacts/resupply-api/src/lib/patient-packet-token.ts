// HMAC-signed token for the public patient-packet signing URL.
//
// The patient receives a link like /patient-packet-sign?token=<token>.
// The token carries the packet row id, a link-version (for revocation
// — bumping patient_packets.link_version invalidates outstanding
// links), and an expiry. No DB lookup is needed to reject a tampered
// or expired link.
//
// Same signing primitive + shared RESUPPLY_LINK_HMAC_KEY as
// lib/patient-packet-token's sibling token helpers (prescription
// request, provider portal, mask fit).

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

interface PatientPacketTokenPayload {
  id: string;
  // link version — must match patient_packets.link_version
  v: number;
  // expiry (Unix seconds)
  e: number;
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

export function signPatientPacketToken(
  packetId: string,
  linkVersion: number,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const payload: PatientPacketTokenPayload = {
    id: packetId,
    v: linkVersion,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type VerifyPatientPacketTokenResult =
  | { valid: true; packetId: string; linkVersion: number }
  | { valid: false };

export function verifyPatientPacketToken(
  token: string,
): VerifyPatientPacketTokenResult {
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
  const p = parsed as PatientPacketTokenPayload;
  if (
    !p ||
    typeof p.id !== "string" ||
    !p.id ||
    typeof p.v !== "number" ||
    typeof p.e !== "number"
  ) {
    return { valid: false };
  }
  if (p.e <= Math.floor(Date.now() / 1000)) return { valid: false };
  return { valid: true, packetId: p.id, linkVersion: p.v };
}
