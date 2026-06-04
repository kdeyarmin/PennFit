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
import { checkLoginRateLimit } from "../rate-limit";
import { issueToken } from "../token";

import {
  renderPasswordResetEmail,
  type AuthEmailContext,
} from "./email-templates";
import type { AuthDeps } from "./types";

const ForgotBody = z.object({
  email: z.string().min(3).max(254),
});

const FORGOT_RATE_LIMIT = {
  maxPerEmail: 15, // keyed to the IP sentinel; email bucket == IP bucket for this endpoint
  maxPerIp: Infinity, // not used — sentinel encodes the IP
  windowMs: 60 * 60 * 1000, // 1 hour
};

interface MakeForgotPasswordHandlerOptions {
  productName: string;
  uiPathPrefix?: string;
}

/**
 * Create an Express handler for the forgot-password endpoint that enforces per-endpoint rate limits, preserves non-enumeration, issues password-reset tokens, logs audit events, and attempts to send reset emails.
 *
 * @param deps - Dependencies required by the handler (repositories, email sender, environment, audit, and helper utilities).
 * @param options - Handler configuration (UI path prefix and product name used when rendering emails).
 * @returns An async Express request handler that always responds with `{ ok: true }` and performs rate limiting, audit logging, token issuance, token persistence, and best-effort email delivery for password resets.
 */
export function makeForgotPasswordHandler(
  deps: AuthDeps,
  options: MakeForgotPasswordHandlerOptions,
) {
  const now = deps.now ?? (() => new Date());
  const resetTokenTtlMs = deps.env.emailTokenTtlHours * 60 * 60 * 1000;

  return async function handleForgot(
    req: Request,
    res: Response,
  ): Promise<void> {
    // Rate-limit FIRST (before any DB look-ups) so an IP flooding the
    // endpoint with random emails is stopped before it generates DB
    // load or triggers email sends.
    const ip = req.ip ?? null;
    // Per-endpoint sentinel keeps forgot-password failures isolated from
    // sign-in and verify-email buckets so those counters don't bleed into
    // each other's rate limits.
    const ipSentinel = `__forgot:${ip ?? "unknown"}`;
    // checkLoginRateLimit with a sentinel key isolates this endpoint's
    // counter from sign-in and verify-email buckets.
    const rl = await checkLoginRateLimit(
      deps.repo,
      { emailLower: ipSentinel, ip: null },
      FORGOT_RATE_LIMIT,
      deps.rateLimitOnError,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSeconds));
      // Still return 200 to preserve non-enumeration: an attacker
      // can't distinguish "rate limited" from "request accepted".
      res.status(200).json({ ok: true });
      return;
    }

    // Record every request (regardless of outcome) against the per-endpoint
    // sentinel so repeat callers accumulate toward the cap, including
    // malformed inputs that exit early below. Without recording up-front,
    // an attacker could spam Zod-parse failures (or unparseable email
    // values) to bypass the cap before sending real probes. Mirrors the
    // reset-password / verify-email handlers.
    void deps.repo.recordLoginAttempt({
      emailLower: ipSentinel,
      ip,
      success: false,
    });

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
      res.status(200).json({ ok: true });
      return;
    }

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
      expiresAt: new Date(t.getTime() + resetTokenTtlMs),
    });

    const ctx: AuthEmailContext = {
      productName: options.productName,
      publicBaseUrl: deps.publicBaseUrl,
      uiPathPrefix: options.uiPathPrefix,
    };
    const rendered = renderPasswordResetEmail(ctx, token.raw, resetTokenTtlMs);
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
          // Avoid logging emailErr.message — it may contain the recipient
          // address or other PII if the mail provider includes it.
          errorName: emailErr instanceof Error ? emailErr.name : "UnknownError",
          errorType: typeof emailErr,
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
/** Default TTL for password-reset tokens (AUTH_EMAIL_TOKEN_TTL_HOURS env var, default 24h). */
export const PASSWORD_RESET_TTL_MS =
  parseInt(process.env.AUTH_EMAIL_TOKEN_TTL_HOURS ?? "24", 10) * 60 * 60 * 1000;
