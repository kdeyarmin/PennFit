// POST /auth/verify-email — consume a signup_verify token and
// activate the account.
//
// Idempotent in spirit: if the token is already consumed (or
// expired), we return 410 (Gone). The SPA can render "this link
// expired — sign in to request a new one."
//
// We don't auto-issue a session on verify. The Stage 2/3 SPA
// flow is: verify → "you're verified, please sign in".

import type { Request, Response } from "express";
import { z } from "zod";

import { hashToken } from "../token";

import { checkLoginRateLimit } from "../rate-limit";
import { authError } from "./responses";
import type { AuthDeps } from "./types";

const VerifyBody = z.object({
  token: z.string().min(1).max(512),
});

// IP-only limit: 10 token-verification attempts per 15-minute window.
// Brute-forcing a 256-bit token is computationally infeasible, but we
// still rate-limit to prevent DB abuse and repeated failed attempts.
const VERIFY_RATE_LIMIT = {
  maxPerEmail: 10, // keyed to the IP sentinel; email bucket == IP bucket for this endpoint
  maxPerIp: Infinity, // not used — sentinel encodes the IP
  windowMs: 15 * 60 * 1000,
};

/**
 * Create an Express handler for POST /auth/verify-email that consumes a `signup_verify` token and activates the associated user account.
 *
 * @param deps - Dependency bag required by the handler (repository, audit function, optional `now`, and rate-limit error behavior).
 * @returns An Express request handler that verifies a signup token, marks the user's email as verified, records the attempt and audit entry, responds with `{ ok: true }` on success, returns `410` for invalid or already-consumed tokens, and returns `429` when rate-limited.
 */
export function makeVerifyEmailHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handleVerifyEmail(
    req: Request,
    res: Response,
  ): Promise<void> {
    const ip = req.ip ?? null;
    // Per-endpoint sentinel isolates verify-email failures from sign-in and
    // forgot-password buckets so those counters don't bleed into each other.
    const ipSentinel = `__verify:${ip ?? "unknown"}`;
    // checkLoginRateLimit with a sentinel key isolates this endpoint's
    // counter from sign-in and forgot-password buckets.
    const rl = await checkLoginRateLimit(
      deps.repo,
      { emailLower: ipSentinel, ip: null },
      VERIFY_RATE_LIMIT,
      deps.rateLimitOnError,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSeconds));
      authError(
        res,
        429,
        "rate_limited",
        "Too many verification attempts. Please wait a few minutes and try again.",
        { retryAfterSeconds: rl.retryAfterSeconds },
      );
      return;
    }

    // Record every request (regardless of outcome) against the per-endpoint
    // sentinel so repeat callers accumulate toward the cap, including
    // malformed inputs that exit early below. Mirrors the reset-password /
    // forgot-password handlers — without recording up-front, an attacker
    // could spam Zod-parse failures (or pre-hash invalidation) to bypass
    // the cap before sending real probes.
    void deps.repo.recordLoginAttempt({
      emailLower: ipSentinel,
      ip,
      success: false,
    });

    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      authError(res, 400, "invalid_input", "Verification token is required.");
      return;
    }
    const hash = hashToken(parsed.data.token);
    if (!hash) {
      authError(
        res,
        410,
        "invalid_input",
        "This verification link is invalid or has expired.",
      );
      return;
    }

    const t = now();
    const consumed = await deps.repo.consumeEmailToken({
      tokenHash: hash,
      at: t,
    });
    if (!consumed || consumed.purpose !== "signup_verify") {
      authError(
        res,
        410,
        "invalid_input",
        "This verification link is invalid or has expired.",
      );
      return;
    }

    await deps.repo.markEmailVerified(consumed.userId, t);

    void deps.audit({
      action: "auth.email_verified",
      adminUserId: consumed.userId,
      ip,
      metadata: { token_purpose: consumed.purpose },
    });

    res.status(200).json({ ok: true });
  };
}
