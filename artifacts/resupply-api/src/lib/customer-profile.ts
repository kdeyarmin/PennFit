// Source-aware customer profile lookup.
//
// The auth middleware (`requireSignedIn` / `attachSignedIn`) attaches
// `req.shopCustomerEmail` and `req.shopCustomerDisplayName` when a
// session resolves; if those fields are absent, the customer is
// genuinely signed-out (or the resolver returned a row with null
// email / display_name, which is also fine to surface). This helper
// is a thin read of the request fields — kept as a function so the
// shop endpoints have one single source of truth for "what email do
// we send to / display?".

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
 */
export async function readCustomerProfile(
  req: Request,
): Promise<CustomerProfile> {
  return {
    email: req.shopCustomerEmail ?? null,
    displayName: req.shopCustomerDisplayName ?? null,
  };
}
