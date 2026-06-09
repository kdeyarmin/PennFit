// Mount factory for the in-house /auth/* router.
//
// The caller — either artifacts/api-server or artifacts/resupply-api —
// constructs an `AuthDeps` (env + repo + audit + email + secure
// flag + publicBaseUrl) and a small `MountOptions` object, then
// calls `makeAuthRouter`.
//
//   POST /auth/sign-up         — public; gated by allowSignUp
//   POST /auth/sign-in         — public
//   POST /auth/sign-out        — public (CSRF-protected)
//   POST /auth/verify-email    — public
//   POST /auth/forgot-password — public
//   POST /auth/reset-password  — public
//   POST /auth/change-password — requires session + CSRF
//   GET  /auth/me              — requires session

import { Router, type IRouter } from "express";

import { makeChangePasswordHandler } from "./change-password";
import { makeCsrfSeedHandler } from "./csrf-seed";
import { makeForgotPasswordHandler } from "./forgot-password";
import { makeMeHandler } from "./me";
import { makeRequireSession } from "./middleware";
import { makeAuthRateLimiter } from "./rate-limit-middleware";
import { makeResetPasswordHandler } from "./reset-password";
import { makeSignInHandler } from "./sign-in";
import { makeVerifySignInMfaHandler } from "./verify-sign-in-mfa";
import { makeSignOutHandler } from "./sign-out";
import { makeSignUpHandler } from "./sign-up";
import { makeVerifyEmailHandler } from "./verify-email";
import type { AuthDeps } from "./types";

export interface AuthRouterOptions {
  /**
   * Brand label used in email subjects + signatures. e.g.
   * "PennFit" or "Resupply". Required because the lib serves
   * both products from the same code path.
   */
  productName: string;
  /**
   * UI path prefix for the verify-email + reset-password links
   * built into outbound emails. Mount the same router twice to
   * get two different link prefixes:
   *   * customer / storefront:  undefined (default)  → /reset-password
   *   * staff / admin console:  "/admin"             → /admin/reset-password
   * Must start with `/` and have no trailing slash. Optional;
   * defaults to no prefix.
   */
  uiPathPrefix?: string;
}

export function makeAuthRouter(
  deps: AuthDeps,
  options: AuthRouterOptions,
): IRouter {
  const router: IRouter = Router();

  const requireSession = makeRequireSession(deps);

  // Edge rate-limits per IP. Defence-in-depth on top of the DB-backed
  // per-email/per-IP failure counter — those throttle GUESS attempts;
  // these cap ATTEMPT VOLUME so an attacker can't burn CPU+DB hammering
  // any one endpoint. Numbers chosen for human-rate use plus headroom
  // for office NAT (many users, one egress IP).
  const signUpLimiter = makeAuthRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 10,
    name: "auth_sign_up",
  });
  const signInLimiter = makeAuthRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    name: "auth_sign_in",
  });
  const verifyEmailLimiter = makeAuthRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    name: "auth_verify_email",
  });
  const forgotPasswordLimiter = makeAuthRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 10,
    name: "auth_forgot_password",
  });
  const resetPasswordLimiter = makeAuthRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 20,
    name: "auth_reset_password",
  });
  const changePasswordLimiter = makeAuthRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 20,
    name: "auth_change_password",
  });

  router.get("/csrf", makeCsrfSeedHandler(deps));

  if (deps.allowSignUp) {
    router.post("/sign-up", signUpLimiter, makeSignUpHandler(deps, options));
  }
  router.post("/sign-in", signInLimiter, makeSignInHandler(deps));
  // Phase B MFA — only mount the verify endpoint when the host
  // wired an MFA probe + a challenge HMAC key. The customer-facing
  // storefront mount doesn't supply either; it keeps the legacy
  // single-step sign-in.
  if (deps.mfa && deps.mfaChallengeHmacKey) {
    router.post(
      "/sign-in/verify-mfa",
      signInLimiter,
      makeVerifySignInMfaHandler(deps),
    );
  }
  router.post("/sign-out", makeSignOutHandler(deps));
  router.post(
    "/verify-email",
    verifyEmailLimiter,
    makeVerifyEmailHandler(deps),
  );
  router.post(
    "/forgot-password",
    forgotPasswordLimiter,
    makeForgotPasswordHandler(deps, options),
  );
  router.post(
    "/reset-password",
    resetPasswordLimiter,
    makeResetPasswordHandler(deps),
  );
  router.post(
    "/change-password",
    changePasswordLimiter,
    requireSession,
    makeChangePasswordHandler(deps),
  );
  router.get("/me", requireSession, makeMeHandler(deps));

  return router;
}

export type {
  AuthDeps,
  AuditWriter,
  AuthRequestLocals,
  CustomerIdResolver,
  EmailAttachment,
  EmailSender,
  MfaProbe,
  MfaProbeSecret,
} from "./types";
export { makeRequireSession, makeRequireRole } from "./middleware";
export {
  renderPasswordResetEmail,
  renderPatientPortalInviteEmail,
  renderVerifyEmail,
  type AuthEmailContext,
  type RenderedEmail,
} from "./email-templates";
