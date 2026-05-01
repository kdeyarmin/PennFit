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
// first; if present and valid, the auth.users row is run through
// the configured `customerIdResolver` (see
// `artifacts/resupply-api/src/lib/auth-deps.ts`) which maps it to
// the legacy `shop_customers.clerk_user_id` value so every
// downstream FK keeps working unchanged after Stage 4c. The
// resolver also returns the user's email + display name, which
// the middleware attaches to the request for the 5 shop
// endpoints that previously called `clerkClient.users.getUser`.
// If the in-house path doesn't apply (AUTH_PROVIDER=clerk, no
// cookie, invalid cookie, locked/revoked user, repo error), we
// fall through to the existing Clerk getAuth() lookup; in that
// case the request gets only `req.userClerkId` and no profile.

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
      /**
       * Optional customer profile attached when the in-house auth
       * path resolved the session AND a customerIdResolver is
       * configured. Handlers that previously called
       * `clerkClient.users.getUser(req.userClerkId)` should prefer
       * these fields when present and fall back to the Clerk
       * lookup when they're absent.
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
 * Resolve the current customer identifier from EITHER the in-house
 * pf_session cookie OR a Clerk session, whichever exists. Returns
 * the resolved customer details or null when no auth path
 * succeeds. Errors in the in-house repo lookup fall through to
 * Clerk so a transient DB blip doesn't 500 every shop request.
 */
async function resolveCustomer(req: Request): Promise<Resolved | null> {
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
              // No resolver — pass auth.users.id through and surface
              // the email + display name from the auth row directly.
              return {
                customerKey: user.id,
                email: user.emailLower,
                displayName: user.displayName,
              };
            }
          }
        } catch {
          // Repo error — fall through to Clerk rather than 5xx.
        }
      }
    }
  }

  const auth = getAuth(req);
  if (auth?.userId) {
    // Clerk path — handlers do their own enrichment via
    // clerkClient.users.getUser. We don't pre-populate the profile
    // fields here.
    return { customerKey: auth.userId, email: null, displayName: null };
  }
  return null;
}

function attach(req: Request, r: Resolved): void {
  req.userClerkId = r.customerKey;
  if (r.email !== null || r.displayName !== null) {
    req.shopCustomerEmail = r.email;
    req.shopCustomerDisplayName = r.displayName;
  }
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
 * `req.userClerkId` (and the optional profile fields) if a session
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
