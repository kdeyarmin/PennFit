// POST /auth/change-password — authed password change.
//
// Mounted under requireSession + CSRF. Verifies the OLD password
// before accepting the new one (mitigates the "attacker sat down
// at a logged-in machine" scenario). On success we revoke every
// OTHER session for the user — the current request keeps working
// (no logout-of-self).

import type { Request, Response } from "express";
import { z } from "zod";

import { checkCsrf } from "../csrf";
import { hashPassword, verifyPassword } from "../password";
import { validatePassword } from "../password-policy";

import { authError } from "./responses";
import type { AuthDeps } from "./types";

const ChangeBody = z.object({
  currentPassword: z.string().min(1).max(2048),
  newPassword: z.string().min(1).max(2048),
});

export function makeChangePasswordHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handleChange(
    req: Request,
    res: Response,
  ): Promise<void> {
    const csrf = checkCsrf(req);
    if (!csrf.ok) {
      authError(
        res,
        403,
        "csrf_failed",
        "Could not verify the request. Please reload and try again.",
      );
      return;
    }

    const user = req.authUser;
    const sessionId = req.authSessionId;
    if (!user || !sessionId) {
      authError(res, 401, "session_required", "Sign-in required.");
      return;
    }

    const parsed = ChangeBody.safeParse(req.body);
    if (!parsed.success) {
      authError(
        res,
        400,
        "invalid_input",
        "Both current and new password are required.",
      );
      return;
    }

    const newPwCheck = validatePassword(parsed.data.newPassword);
    if (!newPwCheck.ok) {
      authError(res, 400, "invalid_input", newPwCheck.error.message, {
        field: "newPassword",
        code: newPwCheck.error.code,
      });
      return;
    }

    const cred = await deps.repo.findCredentialByUserId(user.id);
    if (!cred) {
      // Shouldn't happen for an authed user — but if it does, the
      // user has no current password to verify against. Treat as
      // 401 so the SPA forces a fresh sign-in (or a forgot-password).
      authError(res, 401, "session_required", "Sign-in required.");
      return;
    }

    const ok = await verifyPassword(
      parsed.data.currentPassword,
      cred.passwordHash,
    );
    if (!ok) {
      void deps.audit({
        action: "auth.password_change_failed",
        adminEmail: user.emailLower,
        adminUserId: user.id,
        ip: req.ip ?? null,
        metadata: { reason: "wrong_current" },
      });
      authError(
        res,
        401,
        "invalid_credentials",
        "Current password is incorrect.",
      );
      return;
    }

    const t = now();
    const newHash = await hashPassword(
      newPwCheck.value,
      deps.passwordHashParams,
    );
    await deps.repo.upsertCredential({
      userId: user.id,
      passwordHash: newHash,
      mustChange: false,
    });
    // Keep this session alive; revoke every other one belonging
    // to this user. A separate device that was signed in before
    // the password change has to sign back in.
    await deps.repo.revokeOtherUserSessions(user.id, sessionId, t);

    void deps.audit({
      action: "auth.password_changed",
      adminEmail: user.emailLower,
      adminUserId: user.id,
      ip: req.ip ?? null,
    });

    res.status(200).json({ ok: true });
  };
}
