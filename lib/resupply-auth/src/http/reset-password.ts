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

// Per-IP rate limit on /reset-password.
//
// The dominant threat is token-brute-force — an attacker hitting the
// endpoint with random 32-byte tokens hoping to find a live one.
// That's already infeasible at scale (256 bits of entropy per
// token), but a rate limit makes it categorically impossible without
// pinning a real signal in our audit log.
//
// 30 attempts/hour from a single IP is generous for a real user
// retrying after typing the new-password constraints wrong, and 4
// orders of magnitude tighter than what an attacker would want.
//
// We use the same sentinel-keyed bucket pattern as forgot-password
// and verify-email so reset-password failures don't bleed into the
// sign-in counter (which would degrade the sign-in lockout policy
// for legit users).
const RESET_RATE_LIMIT = {
  maxPerEmail: 30, // keyed to the IP sentinel; email bucket == IP bucket
  maxPerIp: Infinity, // not used — sentinel encodes the IP
  windowMs: 60 * 60 * 1000, // 1 hour
};

export function makeResetPasswordHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handleReset(
    req: Request,
    res: Response,
  ): Promise<void> {
    // Rate-limit FIRST so an attacker brute-forcing tokens can't
    // even reach Zod parsing.
    const ip = req.ip ?? null;
    const ipSentinel = `__reset:${ip ?? "unknown"}`;
    const rl = await checkLoginRateLimit(
      deps.repo,
      { emailLower: ipSentinel, ip: null },
      RESET_RATE_LIMIT,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSeconds));
      authError(
        res,
        429,
        "rate_limited",
        "Too many password-reset attempts. Please try again later.",
      );
      return;
    }

    const parsed = ResetBody.safeParse(req.body);
    if (!parsed.success) {
      // Record against the sentinel so noisy bots accumulate.
      void deps.repo.recordLoginAttempt({
        emailLower: ipSentinel,
        ip,
        success: false,
      });
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
      // Bad tokens count toward the per-IP cap — defense-in-depth
      // against guessing.
      void deps.repo.recordLoginAttempt({
        emailLower: ipSentinel,
        ip,
        success: false,
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
