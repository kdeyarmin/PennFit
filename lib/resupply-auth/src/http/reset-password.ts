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
import { hashToken } from "../token";

import { authError } from "./responses";
import type { AuthDeps } from "./types";

const ResetBody = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(2048),
});

export function makeResetPasswordHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handleReset(
    req: Request,
    res: Response,
  ): Promise<void> {
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
