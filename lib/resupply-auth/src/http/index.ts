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
import { makeForgotPasswordHandler } from "./forgot-password";
import { handleMe } from "./me";
import { makeRequireSession } from "./middleware";
import { makeResetPasswordHandler } from "./reset-password";
import { makeSignInHandler } from "./sign-in";
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
}

export function makeAuthRouter(
  deps: AuthDeps,
  options: AuthRouterOptions,
): IRouter {
  const router: IRouter = Router();

  const requireSession = makeRequireSession(deps);

  if (deps.allowSignUp) {
    router.post("/sign-up", makeSignUpHandler(deps, options));
  }
  router.post("/sign-in", makeSignInHandler(deps));
  router.post("/sign-out", makeSignOutHandler(deps));
  router.post("/verify-email", makeVerifyEmailHandler(deps));
  router.post("/forgot-password", makeForgotPasswordHandler(deps, options));
  router.post("/reset-password", makeResetPasswordHandler(deps));
  router.post(
    "/change-password",
    requireSession,
    makeChangePasswordHandler(deps),
  );
  router.get("/me", requireSession, handleMe);

  return router;
}

export type {
  AuthDeps,
  AuditWriter,
  AuthRequestLocals,
  CustomerIdResolver,
  EmailSender,
} from "./types";
export { makeRequireSession, makeRequireRole } from "./middleware";
export {
  renderPasswordResetEmail,
  renderVerifyEmail,
  type AuthEmailContext,
  type RenderedEmail,
} from "./email-templates";
