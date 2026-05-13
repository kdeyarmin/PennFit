// Short-lived signed token used to bridge the two-step MFA sign-in
// flow.
//
// Why a token (vs. a session cookie or DB row)
// --------------------------------------------
// Between "password verified" and "TOTP code verified" we need to
// remember WHO is trying to sign in without either:
//   * issuing a partial session (would be a security hole — the
//     partial session would have to be tracked separately or
//     blanked-out, both of which add state),
//   * persisting a "challenge" row to the DB (adds write path on
//     every sign-in, complicates the timing-safe response, and
//     leaves orphan rows when the user abandons the flow).
//
// A signed stateless token carries the user_id + expiry in the
// response body, gets stored in component state on the client, and
// arrives back with the TOTP code at /auth/sign-in/verify-mfa.
// Tamper-evident because of the HMAC; replay-bounded because of the
// embedded `exp`.
//
// Token format: `<payload>.<sig>` where
//   payload = base64url(JSON({ uid: <user_id>, exp: <unix_seconds> }))
//   sig     = base64url(HMAC-SHA256(key, "mfa_challenge:" + payload))
//
// The `mfa_challenge:` prefix is a domain separator so the same
// HMAC key can be reused for unrelated token kinds in the future
// without cross-protocol risk.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Default token lifetime — 5 minutes. Long enough for a user to
 *  switch to their authenticator app and type a code, short
 *  enough that a stolen challenge can't be sat on for hours. */
export const DEFAULT_CHALLENGE_TTL_SECONDS = 5 * 60;
const DOMAIN_SEPARATOR = "mfa_challenge:";

export interface MfaChallengeClaims {
  /** auth.users.id of the user mid-sign-in. */
  uid: string;
  /** Unix-seconds expiry. */
  exp: number;
}

export interface MintMfaChallengeOptions {
  uid: string;
  /** Server-side HMAC secret. Caller passes the bytes; we never
   *  read env vars here. */
  hmacKey: Buffer | Uint8Array;
  /** Override `now` for tests; default = Date.now(). */
  nowMs?: number;
  /** Override TTL; default DEFAULT_CHALLENGE_TTL_SECONDS. */
  ttlSeconds?: number;
}

export function mintMfaChallengeToken(opts: MintMfaChallengeOptions): string {
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const ttl = opts.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  const claims: MfaChallengeClaims = {
    uid: opts.uid,
    exp: nowSeconds + ttl,
  };
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims)));
  const sig = base64UrlEncode(
    createHmac("sha256", opts.hmacKey)
      .update(DOMAIN_SEPARATOR + payload)
      .digest(),
  );
  return `${payload}.${sig}`;
}

export type VerifyMfaChallengeResult =
  | { ok: true; claims: MfaChallengeClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyMfaChallengeToken(
  token: string,
  opts: {
    hmacKey: Buffer | Uint8Array;
    nowMs?: number;
  },
): VerifyMfaChallengeResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const payload = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = createHmac("sha256", opts.hmacKey)
    .update(DOMAIN_SEPARATOR + payload)
    .digest();
  let providedSig: Buffer;
  try {
    providedSig = base64UrlDecode(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: MfaChallengeClaims;
  try {
    const json = base64UrlDecode(payload).toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as MfaChallengeClaims).uid !== "string" ||
      typeof (parsed as MfaChallengeClaims).exp !== "number"
    ) {
      return { ok: false, reason: "malformed" };
    }
    claims = parsed as MfaChallengeClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}

// ── base64url helpers ──────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): Buffer {
  // Pad to a multiple of 4 with `=` so the standard decoder accepts it.
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}
