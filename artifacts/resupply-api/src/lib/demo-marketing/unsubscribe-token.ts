// Signed unsubscribe tokens for the newsletter / demo-drip marketing list.
//
// Demo-lead nurture emails (and the storefront newsletter) are keyed by
// EMAIL in public.newsletter_subscribers — there is no contact-id row to
// bind to like platform_contacts. So this token signs the email address
// itself. The public endpoint (`/newsletter-unsubscribe?t=<token>`)
// verifies the token and stamps `unsubscribed_at` on the matching row.
//
// Token format: <base64url("nu"|emailLower|expirySeconds)>.<base64url(sig)>
//   * sig = HMAC-SHA256(payload-bytes, RESUPPLY_LINK_HMAC_KEY)
//   * The "nu" prefix is distinct from the platform-outreach ("pu"),
//     fitter-invite ("fi"), and reminder link scopes so a leaked token
//     can't be replayed against a different unsubscribe surface.
//
// Mirrors lib/platform-outreach/unsubscribe-token.ts; kept separate
// because the bound identity (email vs contact id) and the target table
// differ.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

/** One year. Marketing footers linger in inboxes — an unsubscribe link
 *  must keep working long after the send. */
export const NEWSLETTER_UNSUBSCRIBE_TTL_MS = 365 * 86_400_000;

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

/** Mint an unsubscribe token bound to a (lowercased) email address. */
export function signNewsletterUnsubscribeToken(
  email: string,
  now: Date = new Date(),
): string {
  const emailLower = email.trim().toLowerCase();
  const expiresSec = Math.floor(
    (now.getTime() + NEWSLETTER_UNSUBSCRIBE_TTL_MS) / 1000,
  );
  const payload = `nu|${emailLower}|${expiresSec}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type NewsletterUnsubscribeVerifyResult =
  | { valid: true; email: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

/** Verify an unsubscribe token: signature (constant-time), shape, expiry. */
export function verifyNewsletterUnsubscribeToken(
  token: string,
  now: Date = new Date(),
): NewsletterUnsubscribeVerifyResult {
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
  if (parts.length !== 3 || parts[0] !== "nu") {
    return { valid: false, reason: "malformed" };
  }
  const email = parts[1];
  const expiresSec = Number(parts[2]);
  if (!email || !Number.isFinite(expiresSec)) {
    return { valid: false, reason: "malformed" };
  }
  if (expiresSec * 1000 <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, email };
}
