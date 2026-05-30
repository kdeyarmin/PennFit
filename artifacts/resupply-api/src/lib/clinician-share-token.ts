// HMAC-SHA256 signed tokens for clinician-share-link URLs.
//
// When an admin mints a share link for a referral, we INSERT a
// clinician_share_tokens row and return a token of the shape:
//
//   <base64url-payload>.<base64url-signature>
//
// payload = { id: <row uuid>, e: <expiry unix seconds> }
//
// On GET /portal/clinician/:token the public route verifies the
// HMAC (cheap), then SELECTs the row to enforce revoked_at + the
// authoritative expiry (the payload's `e` is a fail-fast hint;
// the DB has the real answer).
//
// Uses the same RESUPPLY_LINK_HMAC_KEY as fax document tokens +
// email magic links — no new secrets needed.
//
// Why mirror the fax-token format instead of using random opaque
// strings:
//   - HMAC means we can short-circuit invalid tokens without a DB
//     hit (DDoS resilience on the public endpoint).
//   - The DB row is still authoritative for expiry + revocation,
//     so a forged-but-validly-signed token still 404s.
//   - One signing primitive across the codebase.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

interface SharePayload {
  /** clinician_share_tokens row id (uuid). */
  id: string;
  /** Hard expiry in unix seconds — fail-fast hint, DB is authoritative. */
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

export interface SignedShareToken {
  /** The token string to embed in the URL. */
  token: string;
  /** ISO-8601 expiry the caller should also persist on the DB row. */
  expiresAt: string;
}

export function signClinicianShareToken(
  shareRowId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): SignedShareToken {
  const expUnix = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: SharePayload = { id: shareRowId, e: expUnix };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return {
    token: `${payloadEncoded}.${base64urlEncode(sig)}`,
    expiresAt: new Date(expUnix * 1000).toISOString(),
  };
}

export type VerifyClinicianShareTokenResult =
  | { valid: true; shareRowId: string }
  | { valid: false };

export function verifyClinicianShareToken(
  token: string,
): VerifyClinicianShareTokenResult {
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

  const p = parsed as SharePayload;
  if (!p || typeof p.id !== "string" || !p.id || typeof p.e !== "number") {
    return { valid: false };
  }
  if (p.e <= Math.floor(Date.now() / 1000)) return { valid: false };

  return { valid: true, shareRowId: p.id };
}
