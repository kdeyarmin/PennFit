// requireSignedIn — patient-facing auth gate for /shop/me/* endpoints.
//
// This is the lightweight cousin of `requireAdmin`: there's no
// allowlist, no production fail-closed dance, no email-verified
// requirement. The endpoints behind this gate hold customer-scoped
// data only (shipping address, saved card crumbs, that user's own
// order history) — the threat model is "another shop visitor must
// not be able to read my order history", not "an unauthorized
// employee must not be able to access PHI".
//
// Behavior:
//   * 401 if there's no session on the request.
//   * Otherwise sets `req.userClerkId` and continues.
//
// Why we DON'T require a verified email here: a freshly-signed-up
// shopper should be able to start placing orders immediately. The
// allowlist defence (which is what `verified` protects in the admin
// case) doesn't apply — there's no allowlist to spoof past for the
// patient surface.
//
// Provider resolution: the in-house pf_session cookie is checked
// first; if present and valid, `req.userClerkId` is populated with
// the auth.users.id (which acts as the customer identifier going
// forward — Stage 4c handles the data-layer linkage between
// shop_customers.clerk_user_id and shop_customers.auth_user_id).
// If the in-house path doesn't apply (AUTH_PROVIDER=clerk, or no
// cookie, or invalid cookie), we fall through to the existing
// Clerk getAuth() lookup. This preserves dual-mode: a tab still
// using a Clerk JWT keeps working alongside a tab on a local
// cookie.

import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";

import {
  SESSION_COOKIE,
  hashToken,
  isExpired,
  readCookie,
} from "@workspace/resupply-auth";

import { getAuthDepsOrNull } from "../lib/auth-deps";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userClerkId?: string;
    }
  }
}

/**
 * Resolve the current customer identifier from EITHER the in-house
 * pf_session cookie OR a Clerk session, whichever exists. Returns
 * the user id string when authenticated, otherwise null. Errors in
 * the in-house repo lookup fall through to Clerk so a transient DB
 * blip doesn't 500 every shop request.
 */
async function resolveCustomerId(req: Request): Promise<string | null> {
  const deps = getAuthDepsOrNull();
  if (deps) {
    const raw = readCookie(req, SESSION_COOKIE);
    if (raw) {
      const tokenHash = hashToken(raw);
      if (tokenHash) {
        try {
          const session = await deps.repo.findSessionByTokenHash(tokenHash);
          if (
            session &&
            !isExpired(
              { expiresAt: session.expiresAt, revokedAt: session.revokedAt },
              new Date(),
            )
          ) {
            const user = await deps.repo.findUserById(session.userId);
            if (
              user &&
              user.status !== "locked" &&
              user.status !== "revoked"
            ) {
              return user.id;
            }
          }
        } catch {
          // Repo error — fall through to Clerk rather than 5xx.
        }
      }
    }
  }

  const auth = getAuth(req);
  return auth?.userId ?? null;
}

export async function requireSignedIn(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = await resolveCustomerId(req);
  if (!userId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  req.userClerkId = userId;
  next();
}

/**
 * Soft variant: never blocks the request. Just attaches
 * `req.userClerkId` if a session exists. Used by `GET /shop/me`
 * which must always 200 (so the frontend can render a
 * "signed-out" state without an error toast) and by
 * `POST /shop/checkout` which supports both guest + signed-in
 * checkout from the same endpoint.
 */
export async function attachSignedIn(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = await resolveCustomerId(req);
  if (userId) {
    req.userClerkId = userId;
  }
  next();
}
