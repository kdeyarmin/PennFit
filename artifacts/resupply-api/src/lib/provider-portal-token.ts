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
  /**
   * Optional revocation version. Mirrors
   * `providers.portal_link_version` at mint time so a CSR can
   * invalidate every outstanding token for a provider by bumping
   * that column. Older tokens minted before this field existed are
   * treated as v=0 by the verifier, which matches the column's
   * DEFAULT.
   */
  v?: number;
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
  options: { portalLinkVersion?: number } = {},
): string {
  const payload: ProviderPortalPayload = {
    id: providerId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(options.portalLinkVersion !== undefined
      ? { v: options.portalLinkVersion }
      : {}),
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type VerifyProviderPortalTokenResult =
  | { valid: true; providerId: string; version: number }
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

  // Reject if the payload object carries ANY extra fields beyond
  // the two we expect. Today nothing reads extra fields, but a
  // future caller that trusts the parsed payload as authoritative
  // shouldn't be able to read a smuggled `role:"admin"` or
  // `scope:"all"` that survived JSON.parse. Also tighten the
  // typeof checks and enforce UUID-shaped providerId.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { valid: false };
  }
  const p = parsed as Record<string, unknown>;
  const keys = Object.keys(p);
  // Accept either {id, e} (legacy) or {id, e, v} (post-revocation).
  if (
    !keys.includes("id") ||
    !keys.includes("e") ||
    keys.some((k) => k !== "id" && k !== "e" && k !== "v")
  ) {
    return { valid: false };
  }
  if (typeof p.id !== "string" || typeof p.e !== "number") {
    return { valid: false };
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id)
  ) {
    return { valid: false };
  }
  if (!Number.isFinite(p.e) || Date.now() / 1000 > p.e) {
    return { valid: false };
  }
  let version = 0;
  if (p.v !== undefined) {
    if (typeof p.v !== "number" || !Number.isFinite(p.v) || p.v < 0) {
      return { valid: false };
    }
    version = p.v;
  }

  return { valid: true, providerId: p.id, version };
}
