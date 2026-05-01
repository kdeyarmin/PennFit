// Source-aware customer profile lookup.
//
// Stage 5a — Clerk fallback retired. The middleware
// (`requireSignedIn` / `attachSignedIn`) now ALWAYS attaches
// `req.shopCustomerEmail` and `req.shopCustomerDisplayName` when
// a session resolves; if those fields are absent, the customer
// is genuinely signed-out (or the resolver returned a row with
// null email / display_name, which is also fine to surface).
// This helper is now a thin read of the request fields — kept
// as a function so the 5 shop endpoints have one single source
// of truth for "what email do we send to / display?".

import type { Request } from "express";

export interface CustomerProfile {
  email: string | null;
  displayName: string | null;
}

/**
 * Read the current customer's profile (email + displayName).
 * Returns the values attached by the auth middleware after a
 * successful in-house sign-in resolve. If the request isn't
 * authenticated at all (no shop_customer fields present), both
 * return values are null.
 *
 * `userIdOverride` is accepted for back-compat with the dispatcher
 * call sites that wanted to look up a different user id; today it
 * has no effect because the helper reads exclusively from the
 * request envelope. Stage 5d removes the parameter.
 */
export async function readCustomerProfile(
  req: Request,
  _userIdOverride?: string,
): Promise<CustomerProfile> {
  return {
    email: req.shopCustomerEmail ?? null,
    displayName: req.shopCustomerDisplayName ?? null,
  };
}
