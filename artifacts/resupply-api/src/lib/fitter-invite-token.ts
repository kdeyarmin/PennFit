// Signed-link tokens for staff-initiated AI mask-fitter invitations.
//
// A token binds a single fitter_invites row (inviteId) plus an
// expiry. It rides in the public link a CSR sends a patient
// (`/fitter-invite?t=<token>`) and is verified on the two public
// endpoints the storefront calls: resolve (prefill) and complete
// (transmit results).
//
// Token format: <base64url("fi"|inviteId|expirySeconds)>.<base64url(sig)>
//   * sig = HMAC-SHA256(payload-bytes, RESUPPLY_LINK_HMAC_KEY)
//   * The "fi" prefix is distinct from the fitter-lead unsubscribe
//     ("u"-shaped) and open-tracking ("o") payloads so a leaked
//     token from one scope can't be replayed in another.
//
// We deliberately do NOT reuse signLinkToken from
// @workspace/resupply-messaging: that helper binds a conversationId
// and only knows the confirm/edit/stop actions. A fitter invite
// binds a different principal (inviteId) and a different action
// class — keeping the scopes separate beats bending that API.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

/** 30 days. Long enough for a patient to get around to it, short
 *  enough that a stale link doesn't linger indefinitely. Staff can
 *  always resend (which mints a fresh token + extends the window). */
export const FITTER_INVITE_TTL_MS = 30 * 86_400_000;

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

/**
 * Mint an invite token bound to a fitter_invites row id. Exported so
 * the admin create/resend routes can build the public link.
 */
export function signFitterInviteToken(
  inviteId: string,
  now: Date = new Date(),
): string {
  const expiresSec = Math.floor((now.getTime() + FITTER_INVITE_TTL_MS) / 1000);
  const payload = `fi|${inviteId}|${expiresSec}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type FitterInviteVerifyResult =
  | { valid: true; inviteId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify an invite token: signature first (constant-time), then
 * shape, then expiry. Returns the bound inviteId on success.
 */
export function verifyFitterInviteToken(
  token: string,
  now: Date = new Date(),
): FitterInviteVerifyResult {
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

  // Verify the signature before trusting any part of the payload.
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
  if (parts.length !== 3 || parts[0] !== "fi") {
    return { valid: false, reason: "malformed" };
  }
  const inviteId = parts[1];
  const expiresSec = Number(parts[2]);
  if (!inviteId || !Number.isFinite(expiresSec)) {
    return { valid: false, reason: "malformed" };
  }
  if (expiresSec * 1000 <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, inviteId };
}
