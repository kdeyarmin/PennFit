// @workspace/resupply-messaging — HMAC-signed link tokens for email CTAs.
//
// Patients receive an email with three links:
//   - "Confirm order"   → /email/click?t=<token-with-action=confirm>
//   - "Change address"  → /email/click?t=<token-with-action=edit>
//   - "Stop reminders"  → /email/click?t=<token-with-action=stop>
//
// Each token is an HMAC-SHA256 signed payload that carries the
// conversation it belongs to, the action the click should perform, and
// an absolute expiration timestamp. The /email/click route verifies
// the token, branches on action, and records the click.
//
// Why HMAC tokens and not opaque database rows?
//   1. No DB write to send the email. We can render and ship the
//      template without first creating three "click intent" rows.
//   2. Expired-by-construction. The TTL is encoded in the token; we
//      can never accidentally accept a year-old click because we
//      forgot to garbage-collect a row.
//   3. Idempotent. The same token always represents the same intent;
//      double-clicks never bind a click to a different action.
//   4. Stateless verification. The /email/click route doesn't need to
//      coordinate with the sender process — verifying is a hash compute.
//
// Token format: `<base64url(payload-json)>.<base64url(sig)>`
//   where sig = HMAC-SHA256(<base64url-payload-bytes>, key).
//
// Why HMAC the payload BYTES not the raw JSON?
//   Base64url encoding is canonical (one input → one output) so signing
//   the encoded bytes avoids any JSON-canonicalisation hazard at the
//   verifier (whitespace, key order). The verifier base64url-decodes
//   ONLY after signature verification, so an attacker who tampers with
//   the encoded payload changes the signed bytes and fails verify
//   before any JSON parsing happens.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export const LINK_ACTIONS = ["confirm", "edit", "stop"] as const;
export type LinkAction = (typeof LINK_ACTIONS)[number];

interface LinkPayload {
  /** conversation id (uuid) */
  c: string;
  /** action — one of LINK_ACTIONS */
  a: LinkAction;
  /** expiration as UNIX seconds */
  e: number;
  /** issuance as UNIX seconds (informational; not enforced) */
  i: number;
}

export interface SignLinkTokenInput {
  conversationId: string;
  action: LinkAction;
  /**
   * Absolute expiration. Pass a Date or epoch milliseconds. Defaults
   * to "now + 7 days". Tests pass a fixed Date for determinism.
   */
  expiresAt?: Date | number;
  /** Test-only seam — pin "now" for deterministic issuance timestamps. */
  now?: Date;
}

export type VerifyLinkTokenResult =
  | {
      valid: true;
      conversationId: string;
      action: LinkAction;
      expiresAt: Date;
      issuedAt: Date;
    }
  | {
      valid: false;
      reason:
        | "malformed"
        | "bad-signature"
        | "expired"
        | "unknown-action";
    };

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64urlDecode(s: string): Buffer | null {
  // Strict alphabet check — reject anything with characters outside
  // base64url so a tampered token doesn't sneak past as "decoded but
  // garbage".
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

export function signLinkToken(input: SignLinkTokenInput): string {
  if (!LINK_ACTIONS.includes(input.action)) {
    throw new Error(`signLinkToken: unknown action "${input.action}"`);
  }
  if (!input.conversationId) {
    throw new Error("signLinkToken: conversationId is required");
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const expiresMs =
    input.expiresAt instanceof Date
      ? input.expiresAt.getTime()
      : typeof input.expiresAt === "number"
        ? input.expiresAt
        : nowMs + DEFAULT_TTL_SECONDS * 1000;

  const payload: LinkPayload = {
    c: input.conversationId,
    a: input.action,
    e: Math.floor(expiresMs / 1000),
    i: Math.floor(nowMs / 1000),
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  const sigEncoded = base64urlEncode(sig);
  return `${payloadEncoded}.${sigEncoded}`;
}

export interface VerifyLinkTokenOptions {
  /** Test-only seam — pin "now" for deterministic expiry tests. */
  now?: Date;
}

export function verifyLinkToken(
  token: string | null | undefined,
  opts: VerifyLinkTokenOptions = {},
): VerifyLinkTokenResult {
  if (!token || typeof token !== "string") {
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

  const expectedSig = hmacSign(payloadEncoded);
  if (sigBuf.length !== expectedSig.length) {
    return { valid: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(sigBuf, expectedSig)) {
    return { valid: false, reason: "bad-signature" };
  }

  // Signature passed — now decode and parse the payload.
  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false, reason: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { c?: unknown }).c !== "string" ||
    typeof (parsed as { a?: unknown }).a !== "string" ||
    typeof (parsed as { e?: unknown }).e !== "number" ||
    typeof (parsed as { i?: unknown }).i !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }
  const payload = parsed as LinkPayload;
  if (!LINK_ACTIONS.includes(payload.a)) {
    return { valid: false, reason: "unknown-action" };
  }

  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (payload.e <= nowSeconds) {
    return { valid: false, reason: "expired" };
  }

  return {
    valid: true,
    conversationId: payload.c,
    action: payload.a,
    expiresAt: new Date(payload.e * 1000),
    issuedAt: new Date(payload.i * 1000),
  };
}
