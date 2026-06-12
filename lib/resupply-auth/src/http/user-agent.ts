// Shared User-Agent hashing for session issuance + validation.
//
// Sessions store sha256(User-Agent) at issue time (sign-in and
// MFA-verify both stamp it) and `requireSession` compares it on every
// request as a SOFT anomaly signal: a mismatch is observable (logged
// via `AuthDeps.onSessionUserAgentMismatch`) but never blocks the
// request — browsers legitimately change their UA on every update, so
// hard-failing would sign users out monthly for no security gain.

import { createHash } from "node:crypto";

import type { Request } from "express";

/** Hash the User-Agent header (sha256). Stored alongside sessions. */
export function hashUserAgent(req: Request): Buffer | null {
  const ua = req.headers["user-agent"];
  if (!ua || typeof ua !== "string") return null;
  return createHash("sha256").update(ua).digest();
}
