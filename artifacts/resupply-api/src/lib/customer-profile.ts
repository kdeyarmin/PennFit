// Source-aware customer profile lookup.
//
// Five shop endpoints historically called
// `clerkClient.users.getUser(req.userClerkId)` to enrich the
// signed-in customer with their primary email + display name.
// After Stage 4c, in-house users have a UUID for their customer
// key — Clerk would 404 on that.
//
// `requireSignedIn` / `attachSignedIn` now pre-populate
// `req.shopCustomerEmail` and `req.shopCustomerDisplayName` when
// the in-house path resolved the session. This helper checks
// those first; if they're absent (the Clerk path resolved the
// session, or no path did), it falls back to the original
// `clerkClient.users.getUser` call. That preserves dual-mode
// behaviour: a tab on a Clerk JWT still gets enriched the same
// way it did before.

import { clerkClient } from "@clerk/express";
import type { Request } from "express";

import { logger } from "./logger";

export interface CustomerProfile {
  email: string | null;
  displayName: string | null;
}

/**
 * Read the current customer's profile (email + displayName).
 *
 * Precedence:
 *   1. `req.shopCustomerEmail` / `req.shopCustomerDisplayName`
 *      attached by the in-house auth path. If either is set,
 *      we return them without a network round-trip.
 *   2. `clerkClient.users.getUser(req.userClerkId)` — the legacy
 *      Clerk path. Returns null fields on a Clerk API blip
 *      rather than throwing; callers degrade gracefully.
 *
 * Pass `userIdOverride` for handlers that resolve the customer
 * from a different source (e.g. the cart-snapshot dispatcher
 * receives the id off the request body, not the session).
 */
export async function readCustomerProfile(
  req: Request,
  userIdOverride?: string,
): Promise<CustomerProfile> {
  const userId = userIdOverride ?? req.userClerkId;
  if (!userId) {
    return { email: null, displayName: null };
  }

  // In-house path already populated the request — use it.
  if (
    req.shopCustomerEmail !== undefined ||
    req.shopCustomerDisplayName !== undefined
  ) {
    return {
      email: req.shopCustomerEmail ?? null,
      displayName: req.shopCustomerDisplayName ?? null,
    };
  }

  // Clerk path — same logic the 5 endpoints used to inline.
  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    const fullName = [user.firstName, user.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    return {
      email: primary?.emailAddress ?? null,
      displayName: fullName.length > 0 ? fullName : null,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "customer-profile: clerk user lookup failed; serving without enrichment",
    );
    return { email: null, displayName: null };
  }
}
