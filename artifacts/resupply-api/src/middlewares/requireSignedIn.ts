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
//   * Otherwise sets `req.userCustomerId` and continues.
//
// Why we DON'T require a verified email here: a freshly-signed-up
// shopper should be able to start placing orders immediately. The
// allowlist defence (which is what `verified` protects in the admin
// case) doesn't apply — there's no allowlist to spoof past for the
// patient surface.
//
// Stage 5a — Clerk fall-through retired:
//   The middleware now resolves the session strictly via the
//   in-house pf_session cookie. A request that doesn't carry one
//   (or carries an expired / revoked / locked cookie) gets a 401.
//   The `customerIdResolver` in api-server's auth-deps maps the
//   resolved auth.users.id to `shop_customers.customer_id` so
//   every downstream join keeps working. The resolver also
//   returns the user's email + display name, which the middleware
//   attaches to the request for the 5 shop endpoints that
//   previously called `clerkClient.users.getUser`.

import type { NextFunction, Request, Response } from "express";

import {
  SESSION_COOKIE,
  hashToken,
  isExpired,
  readCookie,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../lib/auth-deps";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userCustomerId?: string;
      /**
       * Customer profile attached by `customerIdResolver` after
       * an in-house cookie has been validated. Handlers that need
       * the email / display name should read these fields rather
       * than re-querying.
       */
      shopCustomerEmail?: string | null;
      shopCustomerDisplayName?: string | null;
    }
  }
}

interface Resolved {
  customerKey: string;
  email: string | null;
  displayName: string | null;
}

/**
 * Resolve the current customer identifier from the in-house
 * pf_session cookie. Returns null when no cookie is present or
 * the cookie is invalid (expired / revoked / unknown user /
 * locked / repo error).
 */
async function resolveCustomer(req: Request): Promise<Resolved | null> {
  const deps = getAuthDeps();
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  if (!tokenHash) return null;
  try {
    const session = await deps.repo.findSessionByTokenHash(tokenHash);
    if (
      !session ||
      isExpired(
        { expiresAt: session.expiresAt, revokedAt: session.revokedAt },
        new Date(),
      )
    ) {
      return null;
    }
    const user = await deps.repo.findUserById(session.userId);
    if (!user || user.status === "locked" || user.status === "revoked") {
      return null;
    }
    if (deps.customerIdResolver) {
      const r = await deps.customerIdResolver({
        authUserId: user.id,
        emailLower: user.emailLower,
        displayName: user.displayName,
      });
      return {
        customerKey: r.customerKey,
        email: r.email,
        displayName: r.displayName,
      };
    }
    return {
      customerKey: user.id,
      email: user.emailLower,
      displayName: user.displayName,
    };
  } catch {
    // Repo error — return null. Handler will 401 the request, the
    // SPA reloads /me, and the next attempt sees a healthier DB.
    return null;
  }
}

function attach(req: Request, r: Resolved): void {
  req.userCustomerId = r.customerKey;
  req.shopCustomerEmail = r.email;
  req.shopCustomerDisplayName = r.displayName;
}

export async function requireSignedIn(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const r = await resolveCustomer(req);
  if (!r) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  attach(req, r);
  next();
}

/**
 * Soft variant: never blocks the request. Just attaches
 * `req.userCustomerId` (and the optional profile fields) if a session
 * exists. Used by `GET /shop/me` which must always 200 (so the
 * frontend can render a "signed-out" state without an error
 * toast) and by `POST /shop/checkout` which supports both guest
 * + signed-in checkout from the same endpoint.
 */
export async function attachSignedIn(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const r = await resolveCustomer(req);
  if (r) {
    attach(req, r);
  }
  next();
}
