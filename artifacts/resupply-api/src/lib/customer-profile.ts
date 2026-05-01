// Source-aware customer profile lookup.
//
// `requireSignedIn` / `attachSignedIn` always attach
// `req.shopCustomerEmail` and `req.shopCustomerDisplayName` when a
// session resolves; if those fields are absent the customer is
// genuinely signed-out (or the resolver returned null email /
// display_name, which is also fine to surface). This helper is a
// thin read of the request fields — kept as a function so the shop
// endpoints share one source of truth for "what email do we send
// to / display?".

import type { Request } from "express";

export interface CustomerProfile {
  email: string | null;
  displayName: string | null;
}

/**
 * Read the current customer's profile (email + displayName) from
 * the request envelope populated by the auth middleware. Both
 * fields are null when the request isn't authenticated.
 */
export async function readCustomerProfile(
  req: Request,
): Promise<CustomerProfile> {
  return {
    email: req.shopCustomerEmail ?? null,
    displayName: req.shopCustomerDisplayName ?? null,
  };
}
