// POST /auth/sign-in/verify-mfa — exchange a challenge token + TOTP
// code for an actual session cookie.
//
// This route only exists when AuthDeps.mfa is wired. The customer
// storefront mount doesn't supply `mfa`, so this endpoint isn't
// mounted there — sign-in stays single-step for shop customers.
//
// Contract:
//   POST { challengeToken, code }
//     → 200 { ok: true }                — session cookie set
//     → 401 mfa_challenge_invalid       — token signature or shape bad
//     → 401 mfa_challenge_expired       — token past exp
//     → 400 mfa_code_invalid            — TOTP code wrong / replayed
//     → 404 mfa_not_enrolled            — race: enrollment removed
//                                          between sign-in and verify
//
// PHI / audit posture: every outcome writes an audit row keyed by
// the resolved user_id. The challenge token itself is never logged.
// On code-invalid we DO NOT increment a rate-limit counter here —
// the 30-second step window + last_used_counter replay reject is
// the cost of a TOTP brute-force, and rate-limiting per-challenge
// would lock a user out within a 5-minute window if they fat-finger
// twice in a row.

import { randomBytes } from "node:crypto";

import { type Request, type Response } from "express";
import { z } from "zod";

import {
  buildCsrfCookie,
  buildSessionCookie,
  appendSetCookie,
} from "../cookies";
import { checkCsrf } from "../csrf";
import { verifyMfaChallengeToken } from "../mfa-challenge";
import { hashRecoveryCode, normalizeRecoveryCode } from "../mfa-recovery";
import { issueWindow } from "../session";
import { issueToken } from "../token";
import { verifyTotpCode } from "../totp";

import { authError } from "./responses";
import type { AuthDeps } from "./types";
import { hashUserAgent } from "./user-agent";

// Either a 6-digit TOTP code OR a recovery code. The recovery
// branch accepts anything 1..32 chars and normalizes on the server;
// the actual structural checks happen against the codeHash lookup.
const VerifyBody = z
  .object({
    challengeToken: z.string().min(1).max(2048),
    code: z
      .string()
      .regex(/^\d{6}$/, "code must be 6 digits")
      .optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .refine(
    (b) => Boolean(b.code) !== Boolean(b.recoveryCode),
    "exactly one of `code` or `recoveryCode` is required",
  );

export function makeVerifySignInMfaHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());
  const ttlDays = deps.env.sessionTtlDays;

  return async function handleVerifyMfa(
    req: Request,
    res: Response,
  ): Promise<void> {
    const csrfCheck = checkCsrf(req);
    if (!csrfCheck.ok) {
      authError(res, 403, "csrf_failed", "Request failed a security check.");
      return;
    }

    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      authError(
        res,
        400,
        "invalid_input",
        "A challenge token and 6-digit code are required.",
      );
      return;
    }

    if (!deps.mfa || !deps.mfaChallengeHmacKey) {
      // Should be impossible — the route is only mounted when both
      // are present — but defend against a future mis-mount.
      authError(
        res,
        500,
        "mfa_misconfigured",
        "MFA verification is not configured on this server.",
      );
      return;
    }

    const verified = verifyMfaChallengeToken(parsed.data.challengeToken, {
      hmacKey: deps.mfaChallengeHmacKey,
      nowMs: now().getTime(),
    });
    if (!verified.ok) {
      // Distinguish expired vs invalid so the SPA can prompt
      // "your sign-in timed out, please start over" specifically.
      const code =
        verified.reason === "expired"
          ? "mfa_challenge_expired"
          : "mfa_challenge_invalid";
      void deps.audit({
        action: "auth.mfa_verify_failed",
        ip: req.ip ?? null,
        metadata: { reason: verified.reason },
      });
      authError(
        res,
        401,
        code,
        verified.reason === "expired"
          ? "Sign-in timed out. Please start over."
          : "That sign-in link is invalid. Please start over.",
      );
      return;
    }

    const userId = verified.claims.uid;
    const user = await deps.repo.findUserById(userId);
    if (!user) {
      // Token was valid but the user no longer exists. Treat as a
      // challenge-invalid so we don't leak account state.
      authError(
        res,
        401,
        "mfa_challenge_invalid",
        "Sign-in could not be completed. Please start over.",
      );
      return;
    }
    if (user.status === "locked" || user.status === "revoked") {
      void deps.audit({
        action: "auth.mfa_verify_failed",
        adminEmail: user.emailLower,
        adminUserId: user.id,
        ip: req.ip ?? null,
        metadata: { reason: user.status === "locked" ? "locked" : "revoked" },
      });
      authError(
        res,
        401,
        "mfa_challenge_invalid",
        "Sign-in could not be completed. Please start over.",
      );
      return;
    }

    // Per-user MFA brute-force throttle. Previously the only gate on
    // wrong-code submissions was the 30/15min per-IP rate limiter at
    // the edge — a NAT-pooled or rotating-IP attacker who already had
    // the password could spray a meaningful slice of the 1M TOTP code
    // space across multiple 5-min challenge tokens. Counting failed
    // attempts per user (over the challenge-token TTL window) cuts
    // that off well below the threshold where a 6-digit TOTP becomes
    // brute-forceable in practice.
    const MFA_FAILURE_WINDOW_MS = 10 * 60 * 1000;
    const MFA_FAILURE_MAX = 5;
    const mfaSentinel = `__mfa_verify:${user.id}`;
    try {
      const recentFailures = await deps.repo.countRecentFailures({
        emailLower: mfaSentinel,
        ip: null,
        sinceMs: MFA_FAILURE_WINDOW_MS,
      });
      if (recentFailures >= MFA_FAILURE_MAX) {
        void deps.audit({
          action: "auth.mfa_verify_failed",
          adminEmail: user.emailLower,
          adminUserId: user.id,
          ip: req.ip ?? null,
          metadata: { reason: "rate_limited", recentFailures },
        });
        const retryAfter = Math.ceil(MFA_FAILURE_WINDOW_MS / 1000);
        res.setHeader("Retry-After", String(retryAfter));
        authError(
          res,
          429,
          "rate_limited",
          "Too many incorrect codes. Please wait and try again.",
        );
        return;
      }
    } catch (err) {
      // Fail CLOSED, matching checkLoginRateLimit's posture on the
      // password step: if the brute-force counter can't be read, the
      // gate it backs is off — and an attacker who can degrade the DB
      // shouldn't gain unlimited TOTP guesses for it. A transient DB
      // blip costs one retried sign-in attempt, which is the cheaper
      // failure. Surface through the same observability hook so a
      // sustained outage is visible to ops.
      try {
        await (deps.rateLimitOnError ??
          ((e: unknown) =>
            console.error(
              "[resupply-auth] mfa failure-count probe failed (failing closed)",
              e,
            )))(err, { emailLower: mfaSentinel, ip: req.ip ?? null });
      } catch {
        // Observability must never throw past the gate.
      }
      res.setHeader("Retry-After", "60");
      authError(
        res,
        429,
        "rate_limited",
        "We couldn't verify your code right now. Please try again in a minute.",
      );
      return;
    }

    let secret;
    try {
      secret = await deps.mfa.findActiveSecret(userId);
    } catch (err) {
      void deps.audit({
        action: "auth.mfa_probe_failed",
        adminEmail: user.emailLower,
        adminUserId: user.id,
        ip: req.ip ?? null,
        metadata: {
          err: err instanceof Error ? err.message : String(err),
        },
      });
      authError(
        res,
        500,
        "mfa_probe_failed",
        "Couldn't complete sign-in. Please try again.",
      );
      return;
    }
    if (!secret) {
      // The user disabled MFA between sign-in and verify, or the
      // row was deleted by another admin. Refuse — the password
      // step alone shouldn't be enough now that the client thinks
      // MFA is on the path.
      authError(
        res,
        404,
        "mfa_not_enrolled",
        "MFA is no longer active on this account. Please start over.",
      );
      return;
    }

    // Branch on which factor the SPA supplied. The zod refine
    // already enforced exactly one of {code, recoveryCode}.
    let mfaPathLabel: "totp" | "recovery";
    if (parsed.data.recoveryCode != null) {
      mfaPathLabel = "recovery";
      // Prefer the atomic find-and-spend (consumeRecoveryCode) when
      // the artifact provides it — it can't race under concurrent
      // submissions. Fall back to the legacy two-step path otherwise.
      const hasAtomic = !!deps.mfa.consumeRecoveryCode;
      const hasLegacy =
        !!deps.mfa.findRecoveryCodeMatch && !!deps.mfa.markRecoveryCodeUsed;
      if (!hasAtomic && !hasLegacy) {
        // The artifact hasn't wired the recovery branch. Treat as
        // a wrong code rather than 500 — the SPA can re-prompt for
        // a TOTP code. Audit reflects the misconfig.
        void deps.audit({
          action: "auth.mfa_verify_failed",
          adminEmail: user.emailLower,
          adminUserId: user.id,
          ip: req.ip ?? null,
          metadata: { reason: "recovery_unconfigured" },
        });
        authError(
          res,
          400,
          "mfa_recovery_code_invalid",
          "Recovery codes aren't available on this account.",
        );
        return;
      }
      const normalized = normalizeRecoveryCode(parsed.data.recoveryCode);
      const codeHash = hashRecoveryCode(normalized);
      let match: { id: string } | null;
      try {
        if (hasAtomic) {
          match = await deps.mfa.consumeRecoveryCode!(
            user.id,
            codeHash,
            req.ip ?? null,
          );
        } else {
          match = await deps.mfa.findRecoveryCodeMatch!(user.id, codeHash);
        }
      } catch (err) {
        void deps.audit({
          action: "auth.mfa_probe_failed",
          adminEmail: user.emailLower,
          adminUserId: user.id,
          ip: req.ip ?? null,
          metadata: {
            err: err instanceof Error ? err.message : String(err),
            branch: "recovery",
          },
        });
        authError(
          res,
          500,
          "mfa_probe_failed",
          "Couldn't complete sign-in. Please try again.",
        );
        return;
      }
      if (!match) {
        // Bump the per-user MFA failure counter so brute-force
        // spraying across recovery codes also hits the throttle.
        try {
          // ip: null — the per-user MFA bucket is keyed on the
          // __mfa_verify:<id> sentinel; recording a real `ip` would also
          // bleed MFA-verify failures into the per-IP SIGN-IN lockout
          // (which counts every success:false row for an IP regardless of
          // email_lower), letting fat-fingered TOTP codes lock out other
          // users behind the same NAT. The IP is still captured in the
          // deps.audit row below.
          await deps.repo.recordLoginAttempt({
            emailLower: `__mfa_verify:${user.id}`,
            ip: null,
            success: false,
          });
        } catch {
          // best-effort: keep auth response behavior unchanged
        }
        void deps.audit({
          action: "auth.mfa_verify_failed",
          adminEmail: user.emailLower,
          adminUserId: user.id,
          ip: req.ip ?? null,
          metadata: { reason: "wrong_recovery_code" },
        });
        authError(
          res,
          400,
          "mfa_recovery_code_invalid",
          "That recovery code isn't valid or has already been used.",
        );
        return;
      }
      if (!hasAtomic) {
        // Legacy two-step path: burn the code. Best-effort per the
        // MfaProbe contract — write failures don't block sign-in
        // because findRecoveryCodeMatch already gated on used_at IS
        // NULL (serially correct; non-atomic under concurrent calls).
        try {
          await deps.mfa.markRecoveryCodeUsed!(match.id, req.ip ?? null);
        } catch {
          // Swallowed — see contract.
        }
      }
    } else {
      mfaPathLabel = "totp";
      // Multi-device path: try each enrolled secret. We accept the
      // FIRST that matches and burn its counter. If the probe
      // doesn't implement findAllActiveSecrets we fall back to the
      // single secret returned by findActiveSecret (backwards
      // compat for artifacts that haven't shipped multi-device).
      const candidates = deps.mfa.findAllActiveSecrets
        ? await deps.mfa.findAllActiveSecrets(user.id)
        : [{ id: "", ...secret }];

      let matched: { counter: number; secretId: string } | null = null;
      for (const cand of candidates) {
        const result = verifyTotpCode(cand.secretBase32, parsed.data.code!, {
          window: 1,
          minCounter: cand.lastUsedCounter ?? undefined,
        });
        if (result.ok && result.counter != null) {
          matched = { counter: result.counter, secretId: cand.id };
          break;
        }
      }

      if (!matched) {
        // Bump the per-user MFA failure counter (see the rate-limit
        // gate near the top of this handler). A NAT-pooled attacker
        // can rotate IPs to bypass the edge limiter, but the
        // per-user counter cuts a brute-force run off in seconds.
        // AWAITed (not fire-and-forget) so the failure is durable
        // before we respond — otherwise a sequential attacker's next
        // request reads a stale count and slips past the throttle.
        // Mirrors the recovery-code branch above.
        try {
          // ip: null — the per-user MFA bucket is keyed on the
          // __mfa_verify:<id> sentinel; recording a real `ip` would also
          // bleed MFA-verify failures into the per-IP SIGN-IN lockout
          // (which counts every success:false row for an IP regardless of
          // email_lower), letting fat-fingered TOTP codes lock out other
          // users behind the same NAT. The IP is still captured in the
          // deps.audit row below.
          await deps.repo.recordLoginAttempt({
            emailLower: `__mfa_verify:${user.id}`,
            ip: null,
            success: false,
          });
        } catch {
          // best-effort: keep auth response behavior unchanged
        }
        void deps.audit({
          action: "auth.mfa_verify_failed",
          adminEmail: user.emailLower,
          adminUserId: user.id,
          ip: req.ip ?? null,
          metadata: { reason: "wrong_code", deviceCount: candidates.length },
        });
        authError(
          res,
          400,
          "mfa_code_invalid",
          "Code didn't match. Check the time on your phone and retry.",
        );
        return;
      }
      // Record the verify on the specific device that matched
      // (best-effort — see MfaProbe contract).
      try {
        await deps.mfa.recordVerify(
          user.id,
          matched.counter,
          matched.secretId || undefined,
        );
      } catch {
        // Swallowed — the verify succeeded; missing the counter
        // bump only means the next verify might accept the same
        // window. The 30-second step still bounds the replay.
      }
    }

    // Success: issue session — same code path as sign-in.
    const token = issueToken();
    const csrfRaw = randomBytes(24).toString("base64url");
    const window = issueWindow(now(), { ttlDays });

    const session = await deps.repo.insertSession({
      tokenHash: token.hash,
      userId: user.id,
      expiresAt: window.expiresAt,
      ip: req.ip ?? null,
      userAgentHash: hashUserAgent(req),
    });

    void deps.audit({
      action: "auth.sign_in",
      adminEmail: user.emailLower,
      adminUserId: user.id,
      ip: req.ip ?? null,
      metadata: {
        sessionId: session.id,
        role: user.role,
        mfa: true,
        mfaPath: mfaPathLabel,
      },
    });

    // Clamp to the same 90-day absolute ceiling issueWindow applies to
    // the DB row — a misconfigured AUTH_SESSION_TTL_DAYS > 90 must not
    // mint a cookie that outlives the server-side session.
    const maxAge = Math.min(ttlDays, 90) * 24 * 60 * 60;
    appendSetCookie(res, [
      buildSessionCookie(token.raw, {
        secure: deps.secureCookies,
        maxAgeSeconds: maxAge,
      }),
      buildCsrfCookie(csrfRaw, {
        secure: deps.secureCookies,
        maxAgeSeconds: maxAge,
      }),
    ]);

    res.status(200).json({ ok: true });
  };
}
