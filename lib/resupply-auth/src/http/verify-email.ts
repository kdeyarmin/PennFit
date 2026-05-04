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

import { authError } from "./responses";
import type { AuthDeps } from "./types";

const VerifyBody = z.object({
  token: z.string().min(1).max(512),
});

export function makeVerifyEmailHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handleVerifyEmail(
    req: Request,
    res: Response,
  ): Promise<void> {
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
      ip: req.ip ?? null,
    });

    res.status(200).json({ ok: true });
  };
}
