// POST /auth/sign-in — exchange email + password for a session
// cookie. Most-trafficked auth endpoint; everything else hangs off
// of the sessions this issues.
//
// Flow:
//   1. Validate body shape (zod).
//   2. Rate-limit decision against auth.login_attempts (per email
//      AND per IP).
//   3. Look up the user. If absent OR no credential row OR
//      password mismatch — log a failed attempt, return the
//      generic "invalid email or password".
//   4. Reject locked / revoked users with the SAME generic
//      message (no enumeration of account state).
//   5. Reject unverified email addresses with a distinct error
//      so the SPA can guide them to /verify-email — this is one
//      place we DO leak account existence, but we accept that:
//      bouncing every unverified user back to "invalid
//      credentials" would create a confused-user pit that
//      generates support tickets and password resets.
//   6. On success: issue a session token, write the row, set
//      pf_session + pf_csrf cookies, audit log, record success.
//
// We intentionally leave the response BODY generic ("you're signed
// in") and rely on /auth/me for the SPA to fetch identity. That
// keeps the cookie-issuing path side-effect-only and the identity
// path cacheable.

import { randomBytes } from "node:crypto";

import { type Request, type Response } from "express";
import { z } from "zod";

import {
  buildCsrfCookie,
  buildSessionCookie,
  appendSetCookie,
} from "../cookies";
import { rehashPasswordPreservingProvenance } from "../credential-writes";
import { checkCsrf } from "../csrf";
import { normalizeEmail } from "../email";
import {
  hashPassword,
  verifyPassword,
  verifyPasswordCredential,
} from "../password";
import { mintMfaChallengeToken } from "../mfa-challenge";
import { checkLoginRateLimit, DEFAULT_RATE_LIMIT } from "../rate-limit";
import { issueWindow } from "../session";
import { ADMIN_PASSWORD_TTL_MS } from "../team-invite";
import { issueToken } from "../token";

import { authError } from "./responses";
import type { AuthDeps } from "./types";
import { hashUserAgent } from "./user-agent";

const SignInBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
});

const GENERIC_FAIL_MESSAGE = "Invalid email or password.";
// Same response shape regardless of which path failed — preserves
// the indistinguishability between "no such user" and "wrong
// password".
function genericFail(res: Response, status = 401) {
  return authError(res, status, "invalid_credentials", GENERIC_FAIL_MESSAGE);
}

// Dummy hash used to equalize timing on the "no such user" branch
// with the real "user exists, wrong password" branch. We hash a
// throwaway value the FIRST time the no-user path fires, using the
// same default argon2id parameters real credentials are stored
// with. A prior implementation used a hardcoded hash with weak
// parameters (m=1024,t=1,p=1) which verified in ~7ms vs ~250ms for
// real credentials — a measurable side channel for user
// enumeration. Memoizing the Promise means we pay the ~250ms cost
// exactly once per process and every subsequent miss verifies in
// approximately the same time as a hit.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHashForTimingEqualization(
  params: Parameters<typeof hashPassword>[1],
): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(
      "timing-equalization-placeholder-not-a-real-credential",
      params,
    );
  }
  return dummyHashPromise;
}

/**
 * Create an Express handler for the sign-in endpoint that authenticates users, enforces rate limits and MFA, and issues sessions or MFA challenges.
 *
 * The produced handler implements the application's sign-in flow: CSRF check, input validation, email normalization, rate-limit gating, user/credential lookup, password verification (with best-effort algorithm upgrade), email verification enforcement, optional MFA challenge issuance, and session creation with cookies on success.
 *
 * @param deps - Dependencies and configuration required by the handler. Important fields:
 *   - `repo`: persistence operations for users, credentials, sessions, and login attempts.
 *   - `env.sessionTtlDays`: session lifetime in days.
 *   - `passwordHashParams`: parameters used when rehashing passwords.
 *   - `mfa` (optional): MFA service used to probe for active secrets.
 *   - `mfaChallengeHmacKey` (optional): HMAC key used to mint MFA challenge tokens.
 *   - `secureCookies`: whether cookies should be marked secure.
 *   - `now` (optional): clock function; defaults to `() => new Date()`.
 *   - `rateLimit` (optional): overrides for rate-limit configuration; defaults to `DEFAULT_RATE_LIMIT`.
 *   - `rateLimitOnError` (optional): behavior used when rate-limit checks encounter errors.
 *
 * @returns An Express request handler for POST /auth/sign-in that either issues a session cookie on successful authentication, returns an MFA challenge when required, or responds with appropriate authentication error responses.
 */
export function makeSignInHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());
  const rateConfig = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const ttlDays = deps.env.sessionTtlDays;

  return async function handleSignIn(
    req: Request,
    res: Response,
  ): Promise<void> {
    const csrfCheck = checkCsrf(req);
    if (!csrfCheck.ok) {
      authError(res, 403, "csrf_failed", "Request failed a security check.");
      return;
    }

    const parsed = SignInBody.safeParse(req.body);
    if (!parsed.success) {
      authError(res, 400, "invalid_input", "Email and password are required.");
      return;
    }

    let emailLower: string;
    try {
      emailLower = normalizeEmail(parsed.data.email);
    } catch {
      // Don't disclose "invalid email format" — looks like
      // enumeration. Fold into the generic fail.
      genericFail(res);
      return;
    }

    const ip = req.ip ?? null;

    // Rate-limit decision FIRST so a slow argon2 hash isn't a
    // free side-channel signaling "this email exists".
    const rl = await checkLoginRateLimit(
      deps.repo,
      { emailLower, ip },
      rateConfig,
      deps.rateLimitOnError,
    );
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSeconds));
      authError(
        res,
        429,
        "rate_limited",
        "Too many sign-in attempts. Please wait a few minutes and try again.",
        { retryAfterSeconds: rl.retryAfterSeconds },
      );
      return;
    }

    const user = await deps.repo.findUserByEmail(emailLower);

    // Even when the user doesn't exist we want the response to
    // take roughly as long as a real verify call. Hash a dummy
    // string so the timing channel between "no such user" and
    // "wrong password" stays narrow.
    if (!user) {
      await verifyPassword(
        parsed.data.password,
        await getDummyHashForTimingEqualization(deps.passwordHashParams),
      );
      await deps.repo.recordLoginAttempt({
        emailLower,
        ip,
        success: false,
      });
      genericFail(res);
      return;
    }

    if (user.status === "locked" || user.status === "revoked") {
      await deps.repo.recordLoginAttempt({
        emailLower,
        ip,
        success: false,
      });
      void deps.audit({
        action: "auth.sign_in_failed",
        adminEmail: emailLower,
        ip,
        metadata: { reason: user.status === "locked" ? "locked" : "revoked" },
      });
      genericFail(res);
      return;
    }

    const cred = await deps.repo.findCredentialByUserId(user.id);
    if (!cred) {
      // Invited user with no password yet — same generic response.
      // The /forgot-password flow is how they set one.
      await deps.repo.recordLoginAttempt({
        emailLower,
        ip,
        success: false,
      });
      void deps.audit({
        action: "auth.sign_in_failed",
        adminEmail: emailLower,
        ip,
        metadata: { reason: "no_credential" },
      });
      genericFail(res);
      return;
    }

    // Refuse must_change credentials whose owner never signed in
    // within ADMIN_PASSWORD_TTL_MS. The team-invite "Set their
    // password for them" path stamps `set_by_admin_at` alongside
    // must_change=true; the forced-rotation gate only fires AFTER
    // sign-in, so without this check an operator-typed password
    // would live on a never-signed-in account forever. We run this
    // BEFORE the verify call so the response timing doesn't leak
    // "the password was right, just expired" vs "the password was
    // wrong" — both paths return the same generic message after a
    // dummy verify above (for missing-user) or a real verify (for
    // wrong-password), and this expired branch returns BEFORE
    // doing either. That matches the existing posture for locked /
    // revoked accounts (same generic 401 above), with the one
    // intentional exception that we use a distinct message here so
    // the user knows to ask for a re-invite instead of trying to
    // remember the right password.
    if (cred.mustChange && cred.setByAdminAt) {
      const ageMs = now().getTime() - cred.setByAdminAt.getTime();
      if (ageMs > ADMIN_PASSWORD_TTL_MS) {
        await deps.repo.recordLoginAttempt({
          emailLower,
          ip,
          success: false,
        });
        void deps.audit({
          action: "auth.sign_in_failed",
          adminEmail: emailLower,
          adminUserId: user.id,
          ip,
          metadata: {
            reason: "admin_password_expired",
            ageMs,
            ttlMs: ADMIN_PASSWORD_TTL_MS,
          },
        });
        authError(
          res,
          403,
          "invite_expired",
          "This temporary password has expired. Please ask your administrator to re-invite you.",
        );
        return;
      }
    }

    const verify = await verifyPasswordCredential(parsed.data.password, cred);
    if (!verify.ok) {
      await deps.repo.recordLoginAttempt({
        emailLower,
        ip,
        success: false,
      });
      void deps.audit({
        action: "auth.sign_in_failed",
        adminEmail: emailLower,
        ip,
        metadata: { reason: "wrong_password" },
      });
      genericFail(res);
      return;
    }

    // Transparent algorithm upgrade. The verify step returns
    // needsRehash:true when the credential matched via a non-
    // current algorithm — today there's only argon2id-v1 so this
    // branch is reserved for future algorithm rotation (e.g. an
    // argon2id-v2 with stronger parameters). Rehash with the
    // current default so the next sign-in takes the fast path.
    // Best-effort: if the write fails we still admit the user, and
    // the next sign-in retries the upgrade.
    if (verify.needsRehash) {
      try {
        const upgraded = await hashPassword(
          parsed.data.password,
          deps.passwordHashParams,
        );
        // Algorithm upgrade only — deliberately preserve the
        // existing set_by_admin_at so a stale operator-typed
        // credential doesn't get its expiry clock reset just
        // because we rehashed it.
        await rehashPasswordPreservingProvenance(deps.repo, {
          userId: user.id,
          passwordHash: upgraded,
          mustChange: cred.mustChange,
        });
        void deps.audit({
          action: "auth.password_algo_upgraded",
          adminEmail: emailLower,
          adminUserId: user.id,
          metadata: { from: cred.algo ?? "unknown", to: "argon2id-v1" },
        });
      } catch {
        // Swallow — sign-in succeeded; an upgrade failure is not
        // a user-visible problem and will be retried next time.
      }
    }

    if (!user.emailVerifiedAt) {
      await deps.repo.recordLoginAttempt({
        emailLower,
        ip,
        success: false,
      });
      void deps.audit({
        action: "auth.sign_in_failed",
        adminEmail: emailLower,
        ip,
        metadata: { reason: "email_unverified" },
      });
      authError(
        res,
        403,
        "email_unverified",
        "Please verify your email address before signing in.",
      );
      return;
    }

    // MFA gate (Phase B). If the caller wired an MFA probe AND the
    // user has an active TOTP enrollment, return a challenge token
    // instead of the session cookie. The SPA will collect a 6-digit
    // code and call POST /sign-in/verify-mfa to exchange it for the
    // actual session. The login_attempts row is recorded as a
    // SUCCESS here because password+account checks all passed —
    // the rate-limit gate is about wrong-password storms, not
    // wrong-TOTP storms (TOTP brute-force has its own narrow
    // attack surface and is governed by the 30-second step window
    // + last_used_counter replay reject).
    if (deps.mfa) {
      let mfaSecret;
      try {
        mfaSecret = await deps.mfa.findActiveSecret(user.id);
      } catch (err) {
        // Fail closed — don't fall back to password-only.
        void deps.audit({
          action: "auth.mfa_probe_failed",
          adminEmail: emailLower,
          adminUserId: user.id,
          ip,
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
      if (mfaSecret) {
        if (!deps.mfaChallengeHmacKey) {
          // Probe present but the key is missing → mis-wiring.
          // Refuse to issue the session and refuse to pretend MFA
          // isn't there. The deploy needs the env var set.
          void deps.audit({
            action: "auth.mfa_misconfigured",
            adminEmail: emailLower,
            adminUserId: user.id,
            ip,
            metadata: { reason: "missing_challenge_hmac_key" },
          });
          authError(
            res,
            500,
            "mfa_misconfigured",
            "MFA is enabled on this account but the server isn't configured to challenge for it. Contact your administrator.",
          );
          return;
        }

        await deps.repo.recordLoginAttempt({
          emailLower,
          ip,
          success: true,
        });
        const challengeToken = mintMfaChallengeToken({
          uid: user.id,
          hmacKey: deps.mfaChallengeHmacKey,
          nowMs: now().getTime(),
        });
        void deps.audit({
          action: "auth.mfa_challenge_issued",
          adminEmail: user.emailLower,
          adminUserId: user.id,
          ip,
          metadata: {},
        });
        res.status(200).json({
          ok: true,
          mfaRequired: true,
          challengeToken,
          // No session cookie yet — the SPA must complete
          // /sign-in/verify-mfa to receive it.
        });
        return;
      }
    }

    // Success: issue session.
    const token = issueToken();
    const csrfRaw = randomBytes(24).toString("base64url");
    const window = issueWindow(now(), { ttlDays });

    const session = await deps.repo.insertSession({
      tokenHash: token.hash,
      userId: user.id,
      expiresAt: window.expiresAt,
      ip,
      userAgentHash: hashUserAgent(req),
    });

    await deps.repo.recordLoginAttempt({
      emailLower,
      ip,
      success: true,
    });
    void deps.audit({
      action: "auth.sign_in",
      adminEmail: user.emailLower,
      adminUserId: user.id,
      ip,
      metadata: { sessionId: session.id, role: user.role },
    });

    const maxAge = ttlDays * 24 * 60 * 60;
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
