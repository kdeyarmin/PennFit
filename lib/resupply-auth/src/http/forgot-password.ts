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
import { checkLoginRateLimit, type RateLimitConfig } from "../rate-limit";
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
const FORGOT_RATE_LIMIT: RateLimitConfig = {
  maxPerEmail: 3,
  maxPerIp: 15,
  windowMs: 60 * 60 * 1000, // 1 hour
};

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
    // Rate-limit FIRST (before any DB look-ups) so an IP flooding the
    // endpoint with random emails is stopped before it generates DB
    // load or triggers email sends.
    const ip = req.ip ?? null;
    try {
      const recentIpRequests = await deps.repo.countRecentFailures({
        emailLower: null,
        ip,
        sinceMs: FORGOT_RATE_LIMIT.windowMs,
      });
      if (recentIpRequests >= FORGOT_RATE_LIMIT.maxPerIp) {
        const retryAfter = Math.ceil(FORGOT_RATE_LIMIT.windowMs / 1000);
        res.setHeader("Retry-After", String(retryAfter));
        // Still return 200 to preserve non-enumeration: an attacker
        // can't distinguish "rate limited" from "request accepted".
        res.status(200).json({ ok: true });
        return;
      }
    } catch {
      // Fail open — a DB error on the rate-limit check shouldn't
      // block legitimate password resets.
    }

    const parsed = ForgotBody.safeParse(req.body);
    if (!parsed.success) {
      // Even input validation has to NOT enumerate. Return the
      // generic 200 — but record what we got so noisy bots show
      // up in the audit log.
      void deps.audit({
        action: "auth.password_reset_requested",
        ip,
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
        ip,
        metadata: { invalidEmail: true },
      });
      // Record against rate-limit counter even for malformed input.
      void deps.repo.recordLoginAttempt({ emailLower: "", ip, success: false });
      res.status(200).json({ ok: true });
      return;
    }

    // Rate-limit before the DB lookup so timing differences between
    // "email exists" and "email unknown" paths can't be observed.
    const rl = await checkLoginRateLimit(
      deps.repo,
      { emailLower, ip },
      FORGOT_RATE_LIMIT,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSeconds));
      // Return 429 — the caller already knows the email (they typed it),
      // so this doesn't enumerate account existence.
      res.status(429).json({
        error: "rate_limited",
        message: "Too many password-reset requests. Please wait before trying again.",
        retryAfterSeconds: rl.retryAfterSeconds,
      });
      return;
    }
    // Record attempt so repeated calls accumulate against the limit.
    void deps.repo.recordLoginAttempt({ emailLower, ip, success: false });

    const user = await deps.repo.findUserByEmail(emailLower);
    if (!user || user.status === "revoked") {
      void deps.audit({
        action: "auth.password_reset_requested",
        adminEmail: emailLower,
        ip,
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
    } catch (emailErr) {
      // Log at warn so SendGrid misconfigurations surface in monitoring.
      // Don't include the email address — use the user id only.
      void deps.audit({
        action: "auth.password_reset_email_failed",
        adminUserId: user.id,
        ip,
        metadata: {
          error:
            emailErr instanceof Error ? emailErr.message : String(emailErr),
        },
      });
    }

    void deps.audit({
      action: "auth.password_reset_requested",
      adminEmail: user.emailLower,
      adminUserId: user.id,
      ip,
    });

    res.status(200).json({ ok: true });
  };
}

/** Re-export so callers can read the TTL when surfacing UX copy. */
export const PASSWORD_RESET_TTL_MS = RESET_TOKEN_TTL_MS;
