// GET /auth/csrf — issues a pre-login CSRF seed cookie.
//
// Must be called by the client before POST /sign-in or POST /sign-up
// so there is a pf_csrf cookie in place for the double-submit check.
// On sign-in success the session handler overwrites pf_csrf with a
// fresh session-bound token; this seed only needs to survive the
// sign-in/sign-up form fill (15-minute TTL).
//
// If a pf_csrf cookie already exists (e.g. a signed-in user) we
// skip the Set-Cookie and return 200 so the caller can always call
// this endpoint unconditionally before any state-mutating auth POST.

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

import {
  appendSetCookie,
  buildCsrfCookie,
  CSRF_COOKIE,
  readCookie,
} from "../cookies";
import type { AuthDeps } from "./types";

export function makeCsrfSeedHandler(deps: AuthDeps) {
  return function handleCsrfSeed(req: Request, res: Response): void {
    if (readCookie(req, CSRF_COOKIE)) {
      res.json({ ok: true });
      return;
    }
    const seed = randomBytes(24).toString("base64url");
    appendSetCookie(
      res,
      buildCsrfCookie(seed, {
        secure: deps.secureCookies,
        maxAgeSeconds: 15 * 60,
      }),
    );
    res.json({ ok: true });
  };
}
