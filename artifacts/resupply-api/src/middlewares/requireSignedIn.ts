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
//   * 401 if there's no Clerk session on the request.
//   * Otherwise sets `req.userClerkId` and continues.
//
// Why we DON'T require a verified email here: a freshly-signed-up
// shopper should be able to start placing orders immediately. The
// allowlist defence (which is what `verified` protects in the admin
// case) doesn't apply — there's no allowlist to spoof past for the
// patient surface.

import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userClerkId?: string;
    }
  }
}

export function requireSignedIn(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  const userId = auth?.userId;
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
export function attachSignedIn(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  if (auth?.userId) {
    req.userClerkId = auth.userId;
  }
  next();
}
