// HMAC-SHA256 signed tokens for the provider read-only portal.
//
// A CSR mints a token for a known provider via POST
// /admin/providers/:id/portal-link. The token carries the provider
// row ID and a 30-day TTL. The provider visits the URL and gets a
// read-only view of their caseload.
//
// Same RESUPPLY_LINK_HMAC_KEY as the fax cover-letter token (and
// every other signed link). No new secrets required.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

interface ProviderPortalPayload {
  id: string;
  e: number;
}

const DEFAULT_TTL_SECONDS = 30 * 86400; // 30 days

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
  const standard =
    s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
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

export function signProviderPortalToken(
  providerId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const payload: ProviderPortalPayload = {
    id: providerId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type VerifyProviderPortalTokenResult =
  | { valid: true; providerId: string }
  | { valid: false };

export function verifyProviderPortalToken(
  token: string,
): VerifyProviderPortalTokenResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) return { valid: false };

  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);

  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false };

  const expected = hmacSign(payloadEncoded);
  if (
    sigBuf.length !== expected.length ||
    !timingSafeEqual(sigBuf, expected)
  ) {
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

  const p = parsed as ProviderPortalPayload;
  if (typeof p?.id !== "string" || typeof p?.e !== "number") {
    return { valid: false };
  }
  if (Date.now() / 1000 > p.e) return { valid: false };

  return { valid: true, providerId: p.id };
}
