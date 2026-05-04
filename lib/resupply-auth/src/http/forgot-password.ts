// POST /auth/forgot-password — issue a password-reset token.
//
// Always responds 200 with `{ ok: true }`, regardless of whether
// the email is associated with an account. This is the canonical
// "no enumeration via the reset endpoint" behavior. The audit log
// records what actually happened so ops can investigate abuse.
//
// Works on unverified users too — a forgot-password reset proves
// control of the inbox just as well as a verify-email click does,
// so a successful reset also marks the email as verified.

import type { Request, Response } from "express";
import { z } from "zod";

import { normalizeEmail } from "../email";
import { issueToken } from "../token";

import {
  renderPasswordResetEmail,
  type AuthEmailContext,
} from "./email-templates";
import type { AuthDeps } from "./types";

const ForgotBody = z.object({
  email: z.string().min(3).max(254),
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

interface MakeForgotPasswordHandlerOptions {
  productName: string;
}

export function makeForgotPasswordHandler(
  deps: AuthDeps,
  options: MakeForgotPasswordHandlerOptions,
) {
  const now = deps.now ?? (() => new Date());

  return async function handleForgot(
    req: Request,
    res: Response,
  ): Promise<void> {
    const parsed = ForgotBody.safeParse(req.body);
    if (!parsed.success) {
      // Even input validation has to NOT enumerate. Return the
      // generic 200 — but record what we got so noisy bots show
      // up in the audit log.
      void deps.audit({
        action: "auth.password_reset_requested",
        ip: req.ip ?? null,
        metadata: { invalidInput: true },
      });
      res.status(200).json({ ok: true });
      return;
    }

    let emailLower: string;
    try {
      emailLower = normalizeEmail(parsed.data.email);
    } catch {
      void deps.audit({
        action: "auth.password_reset_requested",
        ip: req.ip ?? null,
        metadata: { invalidEmail: true },
      });
      res.status(200).json({ ok: true });
      return;
    }

    const user = await deps.repo.findUserByEmail(emailLower);
    if (!user || user.status === "revoked") {
      void deps.audit({
        action: "auth.password_reset_requested",
        adminEmail: emailLower,
        ip: req.ip ?? null,
        metadata: { unknownAccount: true },
      });
      res.status(200).json({ ok: true });
      return;
    }

    const t = now();
    const token = issueToken();
    await deps.repo.insertEmailToken({
      tokenHash: token.hash,
      userId: user.id,
      purpose: "password_reset",
      expiresAt: new Date(t.getTime() + RESET_TOKEN_TTL_MS),
    });

    const ctx: AuthEmailContext = {
      productName: options.productName,
      publicBaseUrl: deps.publicBaseUrl,
    };
    const rendered = renderPasswordResetEmail(ctx, token.raw);
    try {
      await deps.email({
        to: parsed.data.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    } catch {
      // The configured EmailSender is responsible for logging
      // delivery failures (see artifacts/*/src/lib/auth-deps.ts).
      // Swallow here so a SendGrid blip doesn't fail the
      // forgot-password endpoint — the user has already been
      // told their request was accepted.
    }

    void deps.audit({
      action: "auth.password_reset_requested",
      adminEmail: user.emailLower,
      adminUserId: user.id,
      ip: req.ip ?? null,
    });

    res.status(200).json({ ok: true });
  };
}

/** Re-export so callers can read the TTL when surfacing UX copy. */
export const PASSWORD_RESET_TTL_MS = RESET_TOKEN_TTL_MS;
