// Signed unsubscribe tokens for platform outreach emails.
//
// Every marketing/outreach email the platform sends to a saved
// `platform_contacts` row carries a one-click unsubscribe link bound to
// that contact id. The public endpoint (`/platform-unsubscribe?t=<token>`)
// verifies the token and flips `platform_contacts.unsubscribed = true`.
//
// Token format: <base64url("pu"|contactId|expirySeconds)>.<base64url(sig)>
//   * sig = HMAC-SHA256(payload-bytes, RESUPPLY_LINK_HMAC_KEY)
//   * The "pu" prefix is distinct from the fitter-invite ("fi") and
//     reminder link scopes so a leaked token can't be replayed elsewhere.
//
// We sign per-contact (not per-send) so a recipient can unsubscribe from
// any past email; the link stays valid for a long window.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

/** One year. Marketing footers linger in inboxes — an unsubscribe link
 *  must keep working long after the send. */
export const PLATFORM_UNSUBSCRIBE_TTL_MS = 365 * 86_400_000;

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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

/** Mint an unsubscribe token bound to a platform_contacts row id. */
export function signPlatformUnsubscribeToken(
  contactId: string,
  now: Date = new Date(),
): string {
  const expiresSec = Math.floor(
    (now.getTime() + PLATFORM_UNSUBSCRIBE_TTL_MS) / 1000,
  );
  const payload = `pu|${contactId}|${expiresSec}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type PlatformUnsubscribeVerifyResult =
  | { valid: true; contactId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

/** Verify an unsubscribe token: signature (constant-time), shape, expiry. */
export function verifyPlatformUnsubscribeToken(
  token: string,
  now: Date = new Date(),
): PlatformUnsubscribeVerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, reason: "malformed" };
  }
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) {
    return { valid: false, reason: "malformed" };
  }
  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);
  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false, reason: "malformed" };

  const expectedSig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  if (
    sigBuf.length !== expectedSig.length ||
    !timingSafeEqual(sigBuf, expectedSig)
  ) {
    return { valid: false, reason: "bad_signature" };
  }

  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false, reason: "malformed" };
  const parts = payloadBuf.toString("utf8").split("|");
  if (parts.length !== 3 || parts[0] !== "pu") {
    return { valid: false, reason: "malformed" };
  }
  const contactId = parts[1];
  const expiresSec = Number(parts[2]);
  if (!contactId || !Number.isFinite(expiresSec)) {
    return { valid: false, reason: "malformed" };
  }
  if (expiresSec * 1000 <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, contactId };
}
