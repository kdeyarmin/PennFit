// GET /auth/me — current user identity, derived from the session
// cookie. Returns 401 (not 403) when there is no session at all —
// the dashboard distinguishes "logged out" from "forbidden".
//
// Mounted UNDER `requireSession`, so by the time the handler runs
// `req.authUser` and `req.authSessionId` are guaranteed to be set.
//
// The `mustChangePassword` field surfaces the `password_credentials.must_change`
// flag set by the admin "set their password for them" invite flow
// (lib/resupply-auth/src/team-invite.ts). The SPA reads it to force
// a redirect to the change-password screen before allowing the user
// into the rest of the admin app — see ConsoleRoute in
// artifacts/cpap-fitter/src/pages/admin/console.tsx. Cleared back to
// false on a successful POST /auth/change-password.

import type { Request, Response } from "express";

import type { AuthDeps } from "./types";

export function makeMeHandler(deps: AuthDeps) {
  return async function handleMe(req: Request, res: Response): Promise<void> {
    const user = req.authUser;
    if (!user) {
      // Should not happen under requireSession, but belt-and-braces.
      res.status(401).json({ error: "session_required" });
      return;
    }
    // Read the credential to surface must_change. A missing credential
    // row (invited-via-email user who hasn't set a password yet) is
    // treated as "no forced rotation pending" — they only get a
    // session AFTER a successful /auth/reset-password, which writes
    // must_change=false.
    //
    // We deliberately FAIL CLOSED on a credential-lookup error here:
    // /me drives the SPA's forced-rotation gate, and silently
    // defaulting mustChangePassword=false on a transient DB error
    // would let a freshly-invited admin slip past the gate and into
    // the console with the operator-typed password still on their
    // account. Returning 5xx instead means the SPA shows its session
    // error state (no console access) until the dependency recovers.
    // No initialiser — the catch branch returns 500 before we reach
    // the success response, so the only path that reads
    // `mustChangePassword` is the successful try block which always
    // assigns it. Initialising to `false` here trips the new
    // `no-useless-assignment` rule (ESLint 10.4).
    let mustChangePassword: boolean;
    try {
      const cred = await deps.repo.findCredentialByUserId(user.id);
      mustChangePassword = cred?.mustChange ?? false;
    } catch (err) {
      // Structured log so ops can alert on the lookup failure even
      // when the audit sink itself is what's struggling. The
      // `event` tag is the stable handle log dashboards page on —
      // see docs/PRODUCTION_READINESS.md ("Logging + alerting") for
      // the threshold and on-call routing. We deliberately pass the
      // Error object to pino (which serializes it with stack) rather
      // than embedding any user fields beyond the user id — logs are
      // treated as world-readable, so no email/PII.
      const log = (req as Request & { log?: { error?: (...args: unknown[]) => void } }).log;
      log?.error?.(
        { event: "auth_me_credential_lookup_failed", err, userId: user.id },
        "auth.me: credential lookup failed; failing closed with 500",
      );
      void deps.audit({
        action: "auth.me_credential_lookup_failed",
        adminEmail: user.emailLower,
        adminUserId: user.id,
        ip: req.ip ?? null,
        metadata: { err: err instanceof Error ? err.message : String(err) },
      });
      res.status(500).json({
        error: "internal",
        message: "Could not load your account. Please try again.",
      });
      return;
    }
    res.status(200).json({
      id: user.id,
      email: user.emailLower,
      role: user.role,
      displayName: user.displayName,
      emailVerified: user.emailVerifiedAt !== null,
      mustChangePassword,
    });
  };
}
