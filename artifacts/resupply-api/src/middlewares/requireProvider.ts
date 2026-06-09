// requireProvider — authentication gate for the provider e-signature
// portal (/api/provider/*).
//
// Composition (mirrors how requireAdmin builds on the in-house auth
// lib, but gates on a provider_portal_accounts link instead of an
// admin role):
//
//   1. requireSession  — validate the pf_session cookie, attach
//      req.authUser. (Reused from @workspace/resupply-auth; this is the
//      exact same session machinery the admin + storefront mounts use.)
//   2. providerCsrf    — double-submit CSRF on state-changing methods.
//      The app-level admin/shop CSRF gates do NOT cover /api/provider,
//      so this is where the provider tree gets its CSRF protection.
//   3. loadProviderAccount — resolve the provider_portal_accounts row
//      for the signed-in user. No row → 403 (the user is a customer /
//      staff member, not a provider). status='disabled' → 403.
//
// MFA posture: an enrolled provider can only obtain a session by
// clearing the TOTP challenge at sign-in (the unified MFA probe in
// lib/auth-deps.ts enforces this on every /auth mount), so any session
// that reaches a data route necessarily passed MFA. A brand-new,
// not-yet-enrolled provider is allowed through requireProvider so the
// SPA can route them to enrollment, but the PHI-bearing data routes add
// `requireProviderMfaEnrolled` on top, which 403s until a verified
// secret exists.

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { checkCsrf } from "@workspace/resupply-auth";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { getAuthDeps } from "../lib/auth-deps";
import { makeRequireSession } from "@workspace/resupply-auth";

export interface ProviderAccountContext {
  /** provider_portal_accounts.id */
  id: string;
  /** resupply.providers.id */
  providerId: string;
  emailLower: string;
  status: "invited" | "active" | "disabled";
  mfaEnrolledAt: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      providerAccount?: ProviderAccountContext;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Lazily built so the AuthDeps (which reads env) is constructed on the
 *  first request rather than at module import. */
let sessionMiddleware: RequestHandler | undefined;
function getSessionMiddleware(): RequestHandler {
  if (!sessionMiddleware) {
    sessionMiddleware = makeRequireSession(getAuthDeps());
  }
  return sessionMiddleware;
}
const requireSession: RequestHandler = (req, res, next) =>
  getSessionMiddleware()(req, res, next);

/** Double-submit CSRF, enforced only on state-changing methods. */
const providerCsrf: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const result = checkCsrf(req);
  if (result.ok) {
    next();
    return;
  }
  req.log?.warn?.(
    { event: "csrf_failed", reason: result.reason, path: req.path },
    "provider csrf check failed",
  );
  res.status(403).json({
    error: "csrf_failed",
    message:
      "Your request failed a security check. Please refresh the page and try again.",
  });
};

const loadProviderAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const user = req.authUser;
  if (!user) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  // Admin payloads are no-store; mirror that for provider responses so
  // a browser back-button never re-renders cached PHI.
  res.setHeader("Cache-Control", "no-store");
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .select("id, provider_id, email_lower, status, mfa_enrolled_at")
      .eq("auth_user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (error) {
      next(error);
      return;
    }
    if (!data) {
      res.status(403).json({
        error: "not_a_provider",
        message: "This account is not enrolled in the provider portal.",
      });
      return;
    }
    if (data.status === "disabled") {
      res.status(403).json({
        error: "account_disabled",
        message:
          "Your provider portal access has been disabled. Please contact the practice.",
      });
      return;
    }
    req.providerAccount = {
      id: data.id,
      providerId: data.provider_id,
      emailLower: data.email_lower,
      status: data.status,
      mfaEnrolledAt: data.mfa_enrolled_at,
    };
    next();
  } catch (err) {
    next(err as Error);
  }
};

/**
 * Full provider gate: session + CSRF + provider-account resolution.
 * Use as a router-level middleware array.
 */
export const requireProvider: RequestHandler[] = [
  requireSession,
  providerCsrf,
  loadProviderAccount,
];

/**
 * Additional gate for PHI-bearing data routes: require a VERIFIED MFA
 * enrollment. Mount AFTER requireProvider. Returns 403
 * `mfa_enrollment_required` so the SPA can route the provider to the
 * enrollment screen.
 */
export const requireProviderMfaEnrolled = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .select("id")
      .eq("account_id", account.id)
      .not("verified_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (error) {
      next(error);
      return;
    }
    if (!data) {
      res.status(403).json({
        error: "mfa_enrollment_required",
        message:
          "Two-factor authentication must be set up before you can review documents.",
      });
      return;
    }
    next();
  } catch (err) {
    next(err as Error);
  }
};
