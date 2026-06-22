// Signed `state` for the Slack "Add to Slack" OAuth flow.
//
// The state binds the initiating tenant (orgId) plus an expiry and rides the
// round-trip to Slack and back. The callback verifies it to learn which tenant
// to install the workspace into — and to defeat CSRF / cross-tenant replay
// (a leaked code can't be redeemed into another org). Mirrors the signed-link
// token pattern in fitter-invite-token.ts (HMAC-SHA256 over the payload with
// RESUPPLY_LINK_HMAC_KEY).
//
// Token format: <base64url("so"|orgId|expirySeconds)>.<base64url(sig)>

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

/** 15 minutes — long enough to complete the Slack consent, short enough that
 *  a leaked state is useless soon after. */
export const SLACK_OAUTH_STATE_TTL_MS = 15 * 60_000;

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

/** Mint a signed state token bound to `orgId`. */
export function signSlackOAuthState(
  orgId: string,
  now: Date = new Date(),
): string {
  const expiresSec = Math.floor(
    (now.getTime() + SLACK_OAUTH_STATE_TTL_MS) / 1000,
  );
  const payload = `so|${orgId}|${expiresSec}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type SlackOAuthStateResult =
  | { valid: true; orgId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

/** Verify a state token: signature (constant-time), shape, then expiry. */
export function verifySlackOAuthState(
  token: string,
  now: Date = new Date(),
): SlackOAuthStateResult {
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
  if (parts.length !== 3 || parts[0] !== "so") {
    return { valid: false, reason: "malformed" };
  }
  const orgId = parts[1];
  const expiresSec = Number(parts[2]);
  if (!orgId || !Number.isFinite(expiresSec)) {
    return { valid: false, reason: "malformed" };
  }
  if (expiresSec * 1000 <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, orgId };
}
