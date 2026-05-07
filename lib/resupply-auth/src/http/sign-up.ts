// POST /auth/sign-up — public account creation. Mounted only when
// AuthDeps.allowSignUp is true (cpap-fitter shop yes; resupply
// staff dashboard no — staff are invited through a separate flow).
//
// Response is intentionally generic: the same 200 is returned
// whether we created a new user, found a verified existing one,
// or found an unverified one and re-sent the verification email.
// Any branch-specific response would let an attacker enumerate
// existing accounts.
//
// We don't issue a session here. The user has to verify their
// email first (see /auth/verify-email).

import type { Request, Response } from "express";
import { z } from "zod";

import { checkCsrf } from "../csrf";
import { normalizeEmail } from "../email";
import { hashPassword } from "../password";
import { validatePassword } from "../password-policy";
import { issueToken } from "../token";

import { renderVerifyEmail, type AuthEmailContext } from "./email-templates";
import { authError } from "./responses";
import type { AuthDeps } from "./types";

const SignUpBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(2048),
  displayName: z.string().min(1).max(120).optional(),
});

interface MakeSignUpHandlerOptions {
  productName: string;
  uiPathPrefix?: string;
}

export function makeSignUpHandler(
  deps: AuthDeps,
  options: MakeSignUpHandlerOptions,
) {
  const role = deps.signUpRole ?? "customer";
  const now = deps.now ?? (() => new Date());
  const tokenTtlMs = deps.env.emailTokenTtlHours * 60 * 60 * 1000;

  return async function handleSignUp(
    req: Request,
    res: Response,
  ): Promise<void> {
    const csrfCheck = checkCsrf(req);
    if (!csrfCheck.ok) {
      authError(res, 403, "csrf_failed", "Request failed a security check.");
      return;
    }

    const parsed = SignUpBody.safeParse(req.body);
    if (!parsed.success) {
      authError(res, 400, "invalid_input", "Email and password are required.");
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

    let emailLower: string;
    try {
      emailLower = normalizeEmail(parsed.data.email);
    } catch {
      authError(res, 400, "invalid_input", "Email address is not valid.");
      return;
    }

    const t = now();
    const ctx: AuthEmailContext = {
      productName: options.productName,
      publicBaseUrl: deps.publicBaseUrl,
      uiPathPrefix: options.uiPathPrefix,
    };

    const existing = await deps.repo.findUserByEmail(emailLower);

    // Already verified — silently no-op so we don't leak that the
    // address has an account. The user knows; an attacker is no
    // wiser. (No verification email goes out in this case so we
    // don't spam an already-active customer.)
    if (existing && existing.emailVerifiedAt) {
      void deps.audit({
        action: "auth.sign_up_existing",
        adminEmail: emailLower,
        ip: req.ip ?? null,
        metadata: { existingUserId: existing.id, status: existing.status },
      });
      res.status(200).json({ ok: true });
      return;
    }

    let userId: string;
    if (existing) {
      // Re-attach: the user previously signed up but didn't verify.
      // Update their password (they may have forgotten the first
      // one) and re-issue a verification token.
      userId = existing.id;
      const hash = await hashPassword(
        passwordCheck.value,
        deps.passwordHashParams,
      );
      await deps.repo.upsertCredential({
        userId,
        passwordHash: hash,
        mustChange: false,
      });
    } else {
      const inserted = await deps.repo.insertUser({
        emailLower,
        displayName: parsed.data.displayName ?? null,
        role,
        status: "invited",
      });
      userId = inserted.id;
      const hash = await hashPassword(
        passwordCheck.value,
        deps.passwordHashParams,
      );
      await deps.repo.upsertCredential({
        userId,
        passwordHash: hash,
        mustChange: false,
      });
    }

    const token = issueToken();
    await deps.repo.insertEmailToken({
      tokenHash: token.hash,
      userId,
      purpose: "signup_verify",
      expiresAt: new Date(t.getTime() + tokenTtlMs),
    });

    const rendered = renderVerifyEmail(ctx, token.raw);
    try {
      await deps.email({
        to: parsed.data.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    } catch {
      // The configured EmailSender is responsible for logging
      // delivery failures. Swallow here so a SendGrid blip
      // doesn't fail sign-up — the user can re-request via
      // /auth/forgot-password (which works on unverified users).
    }

    void deps.audit({
      action: "auth.sign_up",
      adminEmail: emailLower,
      adminUserId: userId,
      ip: req.ip ?? null,
      metadata: { reattach: Boolean(existing) },
    });

    res.status(200).json({ ok: true });
  };
}
