// Mount factory for the in-house /auth/* router.
//
// The caller — either artifacts/api-server or artifacts/resupply-api —
// constructs an `AuthDeps` (env + repo + audit writer + secure flag)
// and calls `mountAuthRoutes(app, deps)`. The factory keeps mount
// order explicit:
//
//   POST /auth/sign-in    — public
//   POST /auth/sign-out   — public (CSRF-protected)
//   GET  /auth/me         — requires session
//
// Everything else (sign-up, verify-email, forgot-password,
// reset-password, change-password) lands in Stage 2b. Mounting
// the partial set in Stage 2a is intentional: it lets the SPA team
// start integrating against the cookie format and /me payload while
// the rest of the surface is wired up.

import { Router, type IRouter } from "express";

import { handleMe } from "./me";
import { makeRequireSession } from "./middleware";
import { makeSignInHandler } from "./sign-in";
import { makeSignOutHandler } from "./sign-out";
import type { AuthDeps } from "./types";

export function makeAuthRouter(deps: AuthDeps): IRouter {
  const router: IRouter = Router();

  const requireSession = makeRequireSession(deps);

  router.post("/sign-in", makeSignInHandler(deps));
  router.post("/sign-out", makeSignOutHandler(deps));
  router.get("/me", requireSession, handleMe);

  return router;
}

export type { AuthDeps, AuditWriter, AuthRequestLocals } from "./types";
export { makeRequireSession, makeRequireRole } from "./middleware";
