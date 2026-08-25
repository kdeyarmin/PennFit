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

import type { AuthBrandResolver } from "./brand";
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
   * Software/product name used in email subjects + body copy,
   * e.g. "Penn Home Medical Supply". Required because the lib is brand-neutral.
   *
   * On a mount that serves many tenants from one bundle this is the FLOOR,
   * not the answer — see `resolveBrand`.
   */
  productName: string;
  /**
   * Company name rendered as the closing signature of every
   * outbound email, e.g. "Penn Home Medical Supply". Optional;
   * omitted → no signature block.
   */
  signatureName?: string;
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
  /**
   * Resolve the brand PER REQUEST — for a mount whose one bundle serves
   * many tenants, so the email carries the brand of the site the user is
   * actually on rather than the mount's static default.
   *
   * Typically host-derived (Host → tenant → that tenant's storefront name).
   * Fail-soft by contract: any throw, or a blank/absent product name, falls
   * back to `productName`/`signatureName` above — a verification or reset
   * email must never fail to send because a branding lookup hiccupped.
   *
   * Omit on a mount that is genuinely the platform's own (the staff console,
   * platform sign-up), where the static platform name IS the right answer.
   */
  resolveBrand?: AuthBrandResolver;
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
  resolveAuthEmailBrand,
  type AuthBrandResolver,
  type AuthEmailBrand,
} from "./brand";
export {
  renderPasswordResetEmail,
  renderPatientPortalInviteEmail,
  renderProviderPortalInviteEmail,
  renderTeamInviteEmail,
  renderVerifyEmail,
  type AuthEmailContext,
  type PatientPortalInviteEmailArgs,
  type ProviderPortalInviteEmailArgs,
  type RenderedEmail,
  type TeamInviteEmailArgs,
} from "./email-templates";
