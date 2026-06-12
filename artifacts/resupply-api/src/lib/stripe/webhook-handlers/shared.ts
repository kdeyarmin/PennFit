// Shared helpers for the Stripe webhook event-family handlers.
//
// Owns the cross-family primitives: the metadata → shop-customer-id
// mapping and the Checkout-Session shipping-address extraction. These
// are used by the checkout-session family AND the subscription family,
// so they live here rather than in either family module. Everything
// here is pure (no DB, no Stripe round-trips).

import { z } from "zod";
import type Stripe from "stripe";

import type { SavedShippingAddress } from "@workspace/resupply-db";

/**
 * Pull our shop-customer id out of Stripe metadata. The mapping
 * lives under `metadata.customer_id` for every Session / Subscription /
 * Customer this codebase creates. Returns null when the key is
 * absent or empty.
 */
export function readCustomerIdFromMetadata(
  meta: Stripe.Metadata | null | undefined,
): string | null {
  if (!meta) return null;
  if (typeof meta.customer_id === "string" && meta.customer_id) {
    return meta.customer_id;
  }
  return null;
}

/**
 * Zod schema for the legacy `session.shipping_details` field shape.
 * This fallback exists for older/backlogged Stripe webhook events
 * that predate `collected_information.shipping_details`. The schema
 * replaces the prior `as unknown as {...}` cast so a structural
 * change on Stripe's side surfaces as a parse failure (null address)
 * rather than silently propagating undefined field access.
 */
const LegacyShippingDetailsSchema = z
  .object({
    shipping_details: z
      .object({
        address: z
          .object({
            line1: z.string().nullable().optional(),
            line2: z.string().nullable().optional(),
            city: z.string().nullable().optional(),
            state: z.string().nullable().optional(),
            postal_code: z.string().nullable().optional(),
            country: z.string().nullable().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * Extract a shipping address from a Checkout Session into our
 * canonical SavedShippingAddress shape, or return null if the
 * session didn't collect one (or collected an obviously incomplete
 * address — e.g. line1 missing).
 *
 * Why we tolerate two different field locations:
 *   - The current Stripe API returns shipping under
 *     `session.collected_information.shipping_details`.
 *   - Older / legacy events delivered it directly at
 *     `session.shipping_details`.
 *   Stripe's TS types only surface the former; we validate the
 *   latter through Zod so a Stripe-side rename surfaces as null
 *   (graceful degradation) instead of a runtime crash.
 *
 * Why we always write country: "US":
 *   The shop is US-only by current product policy. Stripe will only
 *   ever return a US address (we restrict at Checkout config time).
 *   Hardcoding the literal here matches the SavedShippingAddress
 *   `country: "US"` literal type so consumers never have to guard.
 */
export function extractShippingAddressFromSession(
  session: Stripe.Checkout.Session,
): SavedShippingAddress | null {
  const primary = session.collected_information?.shipping_details;
  const legacyParsed = LegacyShippingDetailsSchema.safeParse(session);
  const legacy = legacyParsed.success
    ? legacyParsed.data.shipping_details
    : undefined;
  const shipping = primary ?? legacy ?? null;
  const addr = shipping?.address;
  // Required-field gate — a half-filled address (e.g. only line1) is
  // worse than none, because the customer-facing UI would render the
  // partial value as if it were authoritative.
  if (!addr?.line1 || !addr.city || !addr.state || !addr.postal_code) {
    return null;
  }
  return {
    line1: addr.line1,
    line2: addr.line2 ?? null,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postal_code,
    country: "US",
  };
}
