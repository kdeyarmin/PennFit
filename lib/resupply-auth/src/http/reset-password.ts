// POST /auth/reset-password — consume a password_reset token and
// set a new password.
//
// On success:
//   * Update auth.password_credentials.
//   * Mark email_verified_at if not already (a successful reset
//     proves control of the inbox).
//   * Revoke EVERY active session for the user. If the password
//     was reset because the old one was compromised, we have to
//     assume the attacker has a session; this is the only way to
//     close that door.

import type { Request, Response } from "express";
import { z } from "zod";

import { hashPassword } from "../password";
import { validatePassword } from "../password-policy";
import { checkLoginRateLimit } from "../rate-limit";
import { hashToken } from "../token";

import { authError } from "./responses";
import type { AuthDeps } from "./types";

const ResetBody = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(2048),
});

// IP-only limit on token consumption attempts. The token itself is a
// 256-bit random secret so brute-forcing one is infeasible, but
// rate-limiting protects the DB from abuse and gives us a chokepoint
// if a leaked token is being replayed in parallel. Mirrors the
// verify-email policy (10 per 15 minutes); the two endpoints share a
// nearly identical abuse profile (anonymous POST + token consumption +
// password-hash work).
const RESET_RATE_LIMIT = {
  maxPerEmail: 10, // keyed to the IP sentinel; email bucket == IP bucket for this endpoint
  maxPerIp: Infinity, // not used — sentinel encodes the IP
  windowMs: 15 * 60 * 1000,
};

export function makeResetPasswordHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handleReset(
    req: Request,
    res: Response,
  ): Promise<void> {
    const ip = req.ip ?? null;
    // Per-endpoint sentinel keeps reset-password failures isolated from
    // sign-in / forgot-password / verify-email buckets so those counters
    // don't bleed into each other's rate limits.
    const ipSentinel = `__reset:${ip ?? "unknown"}`;
    const rl = await checkLoginRateLimit(
      deps.repo,
      { emailLower: ipSentinel, ip: null },
      RESET_RATE_LIMIT,
      deps.rateLimitOnError,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSeconds));
      authError(
        res,
        429,
        "rate_limited",
        "Too many password-reset attempts. Please wait a few minutes and try again.",
        { retryAfterSeconds: rl.retryAfterSeconds },
      );
      return;
    }

    // Record every request (regardless of outcome) against the per-endpoint
    // sentinel so repeat callers accumulate toward the cap without bleeding
    // into sign-in / forgot-password / verify-email counters. This repo
    // method is named for sign-in attempts, but here the `success: false`
    // flag is intentionally just "count this request toward the bucket."
    void deps.repo.recordLoginAttempt({
      emailLower: ipSentinel,
      ip,
      success: false,
    });
    const parsed = ResetBody.safeParse(req.body);
    if (!parsed.success) {
      authError(
        res,
        400,
        "invalid_input",
        "Token and new password are required.",
      );
      return;
    }

    const passwordCheck = validatePassword(parsed.data.password);
    if (!passwordCheck.ok) {
      authError(res, 400, "invalid_input", passwordCheck.error.message, {
        field: "password",
        code: passwordCheck.error.code,
      });
      return;
    }

    const hash = hashToken(parsed.data.token);
    if (!hash) {
      authError(
        res,
        410,
        "invalid_input",
        "This password-reset link is invalid or has expired.",
      );
      return;
    }

    const t = now();
    const consumed = await deps.repo.consumeEmailToken({
      tokenHash: hash,
      at: t,
    });
    if (!consumed || consumed.purpose !== "password_reset") {
      void deps.audit({
        action: "auth.password_reset_failed",
        adminUserId: null,
        ip: req.ip ?? null,
        metadata: { reason: "invalid_or_expired_token" },
      });
      authError(
        res,
        410,
        "invalid_input",
        "This password-reset link is invalid or has expired.",
      );
      return;
    }

    const newHash = await hashPassword(
      passwordCheck.value,
      deps.passwordHashParams,
    );
    await deps.repo.upsertCredential({
      userId: consumed.userId,
      passwordHash: newHash,
      mustChange: false,
    });
    await deps.repo.markEmailVerified(consumed.userId, t);
    await deps.repo.revokeAllUserSessions(consumed.userId, t);

    void deps.audit({
      action: "auth.password_reset_completed",
      adminUserId: consumed.userId,
      ip: req.ip ?? null,
    });

    res.status(200).json({ ok: true });
  };
}
