// requireSession — load the current local session and attach the
// user + session id to `req`. Used by the in-house auth flow as a
// building block; consumers compose it with role checks (see
// `requireAdmin` in api-server / resupply-api).

import type { NextFunction, Request, Response } from "express";

import { readCookie, SESSION_COOKIE } from "../cookies";
import { isExpired, slideExpiry } from "../session";
import { hashToken } from "../token";

import { authError } from "./responses";
import type { AuthDeps } from "./types";
import { hashUserAgent } from "./user-agent";

export function makeRequireSession(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());
  const ttlDays = deps.env.sessionTtlDays;

  return async function requireSession(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const raw = readCookie(req, SESSION_COOKIE);
    if (!raw) {
      authError(res, 401, "session_required", "Sign-in required.");
      return;
    }
    const hash = hashToken(raw);
    if (!hash) {
      authError(res, 401, "session_required", "Sign-in required.");
      return;
    }
    const session = await deps.repo.findSessionByTokenHash(hash);
    const t = now();
    if (
      !session ||
      isExpired(
        { expiresAt: session.expiresAt, revokedAt: session.revokedAt },
        t,
      )
    ) {
      authError(res, 401, "session_required", "Sign-in required.");
      return;
    }
    const user = await deps.repo.findUserById(session.userId);
    if (!user || user.status === "locked" || user.status === "revoked") {
      authError(res, 401, "session_required", "Sign-in required.");
      return;
    }

    // Soft User-Agent re-check. Sign-in/MFA-verify stamp
    // sha256(User-Agent) on the session row; until now it was stored
    // but never read back. A mismatch is a stolen-cookie signal worth
    // surfacing to ops, but NOT grounds to block: browsers change
    // their UA string on every update, so hard-failing would sign
    // active users out monthly. Only compared when both sides exist —
    // legacy rows and UA-less clients stay silent.
    if (session.userAgentHash) {
      const currentHash = hashUserAgent(req);
      if (currentHash && !currentHash.equals(session.userAgentHash)) {
        (
          deps.onSessionUserAgentMismatch ??
          (({ userId, sessionId }) =>
            console.warn(
              `[resupply-auth] session user-agent mismatch (soft signal): user=${userId} session=${sessionId}`,
            ))
        )({ userId: user.id, sessionId: session.id });
      }
    }

    // Sliding expiry. Cheap UPDATE; we don't await it on the hot
    // path of every request to avoid adding a round-trip — but
    // we do await it here for simplicity in Stage 2a. Optimize
    // later if it shows up in flame graphs.
    const nextExpires = slideExpiry(
      { issuedAt: session.issuedAt, expiresAt: session.expiresAt },
      t,
      { ttlDays },
    );
    if (nextExpires.getTime() !== session.expiresAt.getTime()) {
      await deps.repo.bumpSession(session.id, nextExpires, t);
    }

    req.authUser = user;
    req.authSessionId = session.id;
    next();
  };
}

/**
 * requireRole — gate a route on an explicit role. Composes on top
 * of requireSession: callers MUST mount requireSession upstream.
 */
export function makeRequireRole(role: "admin" | "agent") {
  return function requireRole(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const user = req.authUser;
    if (!user) {
      authError(res, 401, "session_required", "Sign-in required.");
      return;
    }
    // admin can do anything an agent can.
    if (role === "agent") {
      if (user.role !== "agent" && user.role !== "admin") {
        authError(res, 403, "session_required", "Not authorized.");
        return;
      }
    } else if (user.role !== "admin") {
      authError(res, 403, "session_required", "Not authorized.");
      return;
    }
    next();
  };
}
