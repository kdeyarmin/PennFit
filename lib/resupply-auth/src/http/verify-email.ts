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

import { checkEndpointRateLimit } from "../rate-limit";
import { authError } from "./responses";
import type { AuthDeps } from "./types";

const VerifyBody = z.object({
  token: z.string().min(1).max(512),
});

// IP-only limit: 10 token-verification attempts per 15-minute window.
// Brute-forcing a 256-bit token is computationally infeasible, but we
// still rate-limit to prevent DB abuse and repeated failed attempts.
const VERIFY_RATE_LIMIT = {
  maxPerIp: 10,
  windowMs: 15 * 60 * 1000,
};

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
    const rl = await checkEndpointRateLimit(deps.repo, ipSentinel, VERIFY_RATE_LIMIT);
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
      // Record failed attempt so repeated probes accumulate toward cap.
      void deps.repo.recordLoginAttempt({
        emailLower: ipSentinel,
        ip,
        success: false,
      });
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
    });

    res.status(200).json({ ok: true });
  };
}
