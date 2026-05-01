// POST /auth/sign-out — revoke the current session and clear
// cookies. Idempotent: calling sign-out without a session is a
// no-op success.
//
// Why a POST not a GET: a GET sign-out can be triggered by image
// tags / link previews / accidental link visits, which would log
// users out unexpectedly. POST + CSRF check makes the action
// intentional.

import type { Request, Response } from "express";

import {
  appendSetCookie,
  buildClearCookies,
  readCookie,
  SESSION_COOKIE,
} from "../cookies";
import { checkCsrf } from "../csrf";
import { hashToken } from "../token";

import { authError } from "./responses";
import type { AuthDeps } from "./types";

export function makeSignOutHandler(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handleSignOut(req: Request, res: Response): Promise<void> {
    const csrf = checkCsrf(req);
    if (!csrf.ok) {
      authError(
        res,
        403,
        "csrf_failed",
        "Could not verify the request. Please reload and try again.",
      );
      return;
    }

    const raw = readCookie(req, SESSION_COOKIE);
    if (raw) {
      const hash = hashToken(raw);
      if (hash) {
        const session = await deps.repo.findSessionByTokenHash(hash);
        if (session && !session.revokedAt) {
          await deps.repo.revokeSession(session.id, now());
          void deps.audit({
            action: "auth.sign_out",
            adminUserId: session.userId,
            metadata: { sessionId: session.id },
          });
        }
      }
    }

    appendSetCookie(res, buildClearCookies({ secure: deps.secureCookies }));
    res.status(200).json({ ok: true });
  };
}
