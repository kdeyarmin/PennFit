// POST /shop/checkout — creates a Stripe Hosted Checkout Session and
// returns the redirect URL.
//
// Public (no auth): hosted Checkout owns PCI scope; we never see card
// data. Spam protection is implicit — every Session generation
// reserves a Stripe rate-limit slot, and an attacker creating
// thousands of unused Sessions wastes their own time more than ours.
//
// Idempotency:
//   Two layers of protection against accidental double-charges:
//     1. Frontend passes an `Idempotency-Key` header (UUID per
//        cart-checkout attempt). We forward it to Stripe via
//        `stripe.checkout.sessions.create`'s native idempotency
//        mechanism — Stripe deduplicates server-side and returns
//        the same Session on retry.
//     2. We also hash the cart contents and store that hash on
//        shop_orders. Future enhancement: short-circuit identical
//        repeat clicks within N seconds.
//
// Auto-fulfillment hooks:
//   We don't store line items locally — Stripe is the source of
//   truth. The success page re-fetches the Session by ID to render
//   what was bought. This avoids drift if a price changes between
//   "checkout started" and "checkout completed".

import { createHash, randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { isFeatureEnabled } from "../../lib/feature-flags";
import {
  FIT_ORDERED_MASK_METADATA_KEY,
  FIT_ORDERED_VARIANT_METADATA_KEY,
  FIT_SESSION_METADATA_KEY,
} from "../../lib/fitting/order-link";
import { getActivePickupLocationById } from "../../lib/pickup/locations";
import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import { stripeAccountRequestOptions } from "../../lib/stripe/connect";
import { validateCartItems } from "../../lib/stripe/validate-cart";
import { loadCatalogVisibility } from "../../lib/fitting/catalog-store";
import {
  reserveCartInventory,
  attachSessionToReservations,
  releaseReservationIds,
  DEFAULT_RESERVATION_TTL_MS,
} from "../../lib/inventory/reservations";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import { readCustomerProfile } from "../../lib/customer-profile";
import { rateLimit } from "../../middlewares/rate-limit";
import { attachSignedIn } from "../../middlewares/requireSignedIn";

const checkoutBody = z
  .object({
    items: z
      .array(
        z
          .object({
            priceId: z
              .string()
              .min(1)
              .max(100)
              // Stripe price IDs always start with `price_`; reject
              // anything else early so a typo'd `prod_xxx` surfaces
              // as a clean 400 instead of a Stripe API error.
              .regex(/^price_/, "priceId must start with price_"),
            quantity: z.number().int().min(1).max(20),
            /**
             * Subscribe & Save: per-item flag. "one_time" → invoice
             * line; "subscription" → recurring line. When ANY item
             * carries "subscription" the whole Session is created
             * with mode: "subscription" (Stripe supports mixed
             * recurring + one-time line items in subscription mode;
             * one-time lines are charged on the first invoice and
             * not renewed).
             */
            mode: z.enum(["one_time", "subscription"]).default("one_time"),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    /**
     * Set when this checkout came from the mask fitter, so the paid order
     * can be linked back to the fitting that produced it (0483's
     * downstream-outcome columns). Optional — most shop checkouts are
     * ordinary resupply and carry neither field.
     */
    fitSessionId: z.string().uuid().optional(),
    /**
     * The mask the patient actually chose on the results page, as the
     * engine's slug. Deliberately NOT assumed to be the recommendation:
     * they may well have picked an alternative, and that difference is
     * what the acceptance metric measures.
     */
    orderedMaskSlug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    /** Size variant behind that choice, so the size is auditable too. */
    orderedVariantId: z.string().uuid().optional(),
    /**
     * Where Stripe redirects after success. Must be on our public
     * origin. We don't accept arbitrary redirects from clients —
     * doing so would turn our Stripe account into an open redirector.
     */
    successPath: z
      .string()
      .startsWith("/")
      .max(200)
      .default("/shop/checkout-success"),
    cancelPath: z.string().startsWith("/").max(200).default("/shop/cart"),
    /**
     * Fulfillment choice. "ship" (default) collects a shipping address
     * at Stripe and runs the carrier/tracking lifecycle. "pickup" skips
     * the shipping address and the order is collected in store at
     * `pickupLocationId`. Pickup is gated on the `storefront.pickup`
     * feature flag and is only valid for one-time orders.
     */
    fulfillmentMethod: z.enum(["ship", "pickup"]).default("ship"),
    /** Required when fulfillmentMethod === "pickup": an active location. */
    pickupLocationId: z.string().uuid().nullish(),
  })
  .strict();

function hashCart(
  items: Array<{ priceId: string; quantity: number; mode?: string }>,
): string {
  // Stable hash: sort by priceId so [{a,1},{b,2}] and [{b,2},{a,1}]
  // collapse to the same hash.
  const sorted = [...items].sort((a, b) => a.priceId.localeCompare(b.priceId));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

const router: IRouter = Router();

// Rate limit /shop/checkout — public endpoint that creates a Stripe
// Session + a shop_orders row on every hit. Without throttling, a
// scripted client could create thousands of orphaned Sessions and
// burn through Stripe rate budget. 10/min/IP is comfortably above
// "human refilling cart and re-clicking" but cuts off automated
// abuse early.
const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  name: "shop_checkout",
});

router.post(
  "/shop/checkout",
  checkoutLimiter,
  attachSignedIn,
  async (req, res) => {
    // Control Center feature gate. Admins can disable new checkouts
    // from the UI (e.g. during an outage or inventory freeze) without
    // a deploy; existing orders and webhooks keep flowing because the
    // gate is only on this create-session endpoint.
    if (!(await isFeatureEnabled("storefront.checkout", req.orgId))) {
      res.status(503).json({
        error: "checkout_disabled",
        message:
          "Checkout is temporarily unavailable. Please try again in a few minutes.",
      });
      return;
    }

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json(SHOP_UNAVAILABLE_BODY);
      return;
    }

    const parsed = checkoutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { items, successPath, cancelPath, fulfillmentMethod } = parsed.data;

    // Subscription mode is enabled if ANY item carries mode:
    // "subscription". Stripe will charge any sibling one-time items on
    // the first invoice. Subscription mode requires a Customer (not
    // just customer_email) so we can manage / cancel later — gate the
    // whole flow on the user being signed-in.
    const isSubscription = items.some((it) => it.mode === "subscription");
    if (isSubscription && !req.userCustomerId) {
      res.status(401).json({
        error: "sign_in_required",
        message:
          "You'll need to sign in before subscribing — auto-ship is tied to your account so you can pause or cancel anytime.",
      });
      return;
    }

    // In-store pickup validation. Resolve the chosen location to an
    // active row up front so a stale / tampered id can't be persisted
    // onto the order, and so we can refuse cleanly before reserving a
    // Stripe Session.
    const isPickup = fulfillmentMethod === "pickup";
    let pickupLocationId: string | null = null;
    if (isPickup) {
      // Auto-ship is inherently a recurring-shipping relationship —
      // pickup doesn't apply. Keep the subscription branch ship-only.
      if (isSubscription) {
        res.status(400).json({
          error: "pickup_not_for_subscription",
          message:
            "In-store pickup isn't available for Subscribe & Save orders. Choose shipping, or place this as a one-time order.",
        });
        return;
      }
      if (!(await isFeatureEnabled("storefront.pickup", req.orgId))) {
        res.status(400).json({
          error: "pickup_unavailable",
          message: "In-store pickup isn't available right now.",
        });
        return;
      }
      const location = parsed.data.pickupLocationId
        ? await getActivePickupLocationById(
            req.orgId ?? "",
            parsed.data.pickupLocationId,
          )
        : null;
      if (!location) {
        res.status(400).json({
          error: "pickup_location_invalid",
          message:
            "Choose a valid pickup location before continuing to checkout.",
        });
        return;
      }
      pickupLocationId = location.id;
    }

    const successUrl = `${config.publicBaseUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${config.publicBaseUrl}${cancelPath}`;
    // Hash uses priceId+qty+mode so two identical-priced carts with
    // different mode mixes don't collapse to the same hash.
    const cartHash = hashCart(
      items.map((it) => ({
        priceId: it.priceId,
        quantity: it.quantity,
        mode: it.mode,
      })),
    );

    // Namespace the client-supplied Idempotency-Key per signed-in
    // customer (or per IP for guests) + cart contents before handing
    // it to Stripe. Stripe scopes idempotency keys across the whole
    // API key, so two unrelated checkouts that happen to ship the
    // same client key would otherwise resolve to the SAME Stripe
    // Session — user B would receive user A's session URL, line
    // items, and Stripe customer attachment (cross-user PHI / cart
    // leak). Including cartHash also handles "same user clicks Buy
    // twice with different carts and a browser-cached header" —
    // Stripe rejects mismatched bodies for a reused key, so keying
    // on cart contents avoids the idempotency_error UX glitch and
    // ensures a real second checkout creates a fresh Session.
    const clientKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : randomUUID();
    const idempotencyKey = createHash("sha256")
      .update(
        `${req.userCustomerId ?? `guest:${req.ip ?? "unknown"}`}|${clientKey}|${cartHash}|${isSubscription ? "sub" : "one"}`,
      )
      .digest("hex");

    // Pin the Stripe Checkout Session lifetime to the inventory-hold TTL so the
    // session and the hold lapse TOGETHER. Without an explicit expires_at a
    // session lives ~24h while the hold used to expire in 15 min — after which
    // the hold stopped counting toward availability but the session was still
    // payable, so a second buyer could be granted the same unit and both could
    // pay → oversell. Same wall-clock window feeds both (epoch seconds for
    // Stripe; the hold derives its own from DEFAULT_RESERVATION_TTL_MS).
    const sessionExpiresAtSec = Math.floor(
      (Date.now() + DEFAULT_RESERVATION_TTL_MS) / 1000,
    );

    const stripe = getStripeClient(config);
    // Stripe Connect (G5): route the Checkout session + its Customer to the
    // tenant's connected account when set; NULL → {} → platform account.
    const connectOptions = await stripeAccountRequestOptions(req.orgId);

    // Catalog guard: every price in the cart must belong to the approved
    // shop catalog and respect stock/type constraints. The sibling
    // /shop/me/quick-checkout route applies the same guard; without it a
    // tampered cart could check out stale/legacy prices, out-of-stock
    // items, or SKUs intentionally excluded from /shop/products.
    // Validate against the SAME account the Checkout session is created on
    // (connectOptions) so a connected tenant's cart is checked against their
    // catalog, not the platform's — otherwise every line is price_not_found.
    // Brands the tenant dropped are refused at the till, not just hidden
    // on the shelf. A cart lives in the shopper's localStorage and a
    // reorder replays an older purchase, so a line added before the brand
    // was hidden still reaches here — and taking payment for something
    // the provider will not ship is exactly what hiding it was meant to
    // prevent. Fail-open on a lookup miss, like every other read of this.
    const cartValidation = await validateCartItems(
      stripe,
      items,
      connectOptions,
      (await loadCatalogVisibility(req.orgId)).hiddenManufacturers,
    );
    if (!cartValidation.ok) {
      req.log?.warn(
        { errors: cartValidation.errors },
        "shop checkout: cart validation failed",
      );
      res.status(400).json({
        error: "cart_invalid",
        issues: cartValidation.errors.map((e) => ({
          priceId: e.priceId,
          reason: e.reason,
          message: e.message,
        })),
      });
      return;
    }

    // Inventory reservation / oversell guard. validateCart compared the cart
    // against the live stock_count, but between here and payment completion
    // concurrent buyers could each pass that same check and all complete →
    // oversell. Reserve the requested units now so a second concurrent buyer
    // is refused. FAIL-OPEN: a reservation-system error returns ok:true with
    // no ids and checkout proceeds unguarded (the pre-existing behaviour) —
    // only a clean "oversold" verdict blocks the sale. We resolve the org the
    // same way the shop_orders mirror below does (guest → seed tenant).
    const reservationOrgId = req.orgId ?? (await resolveSeedOrgId());
    let reservationIds: string[] = [];
    if (reservationOrgId) {
      const reservation = await reserveCartInventory({
        orgId: reservationOrgId,
        stripe,
        requestOptions: connectOptions,
        items,
        // Key the hold to the SAME namespaced idempotency key we hand Stripe
        // below, so a client retry of this checkout reuses its existing hold
        // instead of being refused with a phantom oversell on a last-unit SKU.
        idempotencyKey,
        log: req.log,
      });
      if (!reservation.ok) {
        req.log?.warn(
          { productId: reservation.oversoldProductId },
          "shop checkout: inventory reservation refused (oversold)",
        );
        res.status(409).json({
          error: "out_of_stock",
          message:
            "Sorry — one or more items just sold out while you were checking out. Please adjust your cart and try again.",
        });
        return;
      }
      reservationIds = reservation.reservationIds;
    }

    // If the user is signed in, attach (or create) their Stripe Customer
    // so the saved card + address pre-fill on the Stripe page AND so the
    // card from this checkout becomes saved-on-file for next time. We
    // do this best-effort: if customer creation fails, fall through to
    // anonymous checkout rather than blocking the order — guest mode
    // is the documented fallback.
    let stripeCustomerId: string | null = null;
    let customerEmail: string | null = null;
    if (req.userCustomerId) {
      try {
        const profile = await readCustomerProfile(req);
        customerEmail = profile.email;
        const mapping = await getOrCreateStripeCustomer(config, {
          orgId: req.orgId,
          customerId: req.userCustomerId,
          email: customerEmail,
          displayName: profile.displayName,
        });
        stripeCustomerId = mapping.stripeCustomerId;
      } catch (err) {
        req.log?.warn(
          { err },
          "shop checkout: signed-in customer attachment failed; continuing as guest",
        );
      }
    }

    // Common metadata for both payment + subscription flows. The
    // fulfillment fields are read back by the Stripe webhook
    // (markPaid) and persisted onto the shop_orders row.
    const sessionMetadata: Record<string, string> = {
      source: "pennpaps-shop",
      cart_hash: cartHash,
      flow: isSubscription ? "subscription" : "standard",
      fulfillment_method: fulfillmentMethod,
      ...(pickupLocationId ? { pickup_location_id: pickupLocationId } : {}),
      ...(req.userCustomerId ? { customer_id: req.userCustomerId } : {}),
      // Stamp the originating tenant so the webhook can attribute the paid
      // order to the right org. A non-seed tenant whose Connect account isn't
      // charges-enabled yet runs checkout on the PLATFORM account, so the
      // resulting event carries no `event.account`; without this the webhook
      // would fall back to the seed org, orphan the pending row, and write the
      // paid order into the seed tenant's books (multi-tenant mis-attribution).
      ...(req.orgId ? { org_id: req.orgId } : {}),
      // Fitting attribution, read back by the webhook. Absent for an
      // ordinary shop checkout.
      ...(parsed.data.fitSessionId
        ? { [FIT_SESSION_METADATA_KEY]: parsed.data.fitSessionId }
        : {}),
      ...(parsed.data.orderedMaskSlug
        ? { [FIT_ORDERED_MASK_METADATA_KEY]: parsed.data.orderedMaskSlug }
        : {}),
      ...(parsed.data.orderedVariantId
        ? { [FIT_ORDERED_VARIANT_METADATA_KEY]: parsed.data.orderedVariantId }
        : {}),
    };

    let session;
    try {
      if (isSubscription) {
        // Subscription mode. Mixed line_items (recurring + one-time)
        // are valid — one-time SKUs are charged on the first invoice
        // and not renewed. We MUST attach `customer` (we already
        // gated on req.userCustomerId above so stripeCustomerId is
        // populated unless the customer-create best-effort failed —
        // in which case we have to refuse rather than silently
        // anonymise a recurring billing relationship).
        if (!stripeCustomerId) {
          res.status(503).json({
            error: "stripe_customer_unavailable",
            message:
              "We couldn't link your account to billing right now. Please try again in a moment, or use one-time checkout.",
          });
          return;
        }
        session = await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            expires_at: sessionExpiresAtSec,
            customer: stripeCustomerId,
            customer_update: {
              shipping: "auto",
              address: "auto",
              name: "auto",
            },
            line_items: items.map((it) => ({
              price: it.priceId,
              quantity: it.quantity,
            })),
            success_url: successUrl,
            cancel_url: cancelUrl,
            shipping_address_collection: { allowed_countries: ["US"] },
            phone_number_collection: { enabled: true },
            metadata: sessionMetadata,
            // Stamp metadata onto the subscription itself so the
            // customer.subscription.* webhook can recover the buyer's
            // customer_id without having to look up the originating
            // Session.
            subscription_data: {
              metadata: {
                customer_id: req.userCustomerId!,
                source: "pennpaps-shop",
                // Propagate the originating tenant onto the Subscription
                // too. A non-seed tenant whose Connect account isn't
                // charges-enabled yet runs subscription checkout on the
                // PLATFORM account, so customer.subscription.* events carry
                // no event.account; without org_id on the subscription the
                // webhook would scope shop_subscriptions to the seed org.
                // Session metadata alone doesn't cover these — they fire on
                // the Subscription object, not the Session.
                ...(req.orgId ? { org_id: req.orgId } : {}),
              },
            },
            automatic_tax: { enabled: false },
          },
          { idempotencyKey, ...connectOptions },
        );
      } else {
        session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            expires_at: sessionExpiresAtSec,
            ...(stripeCustomerId
              ? {
                  customer: stripeCustomerId,
                  // setup_future_usage saves the card to the Customer
                  // for one-click reorder. Only set when we have a
                  // customer attached — Stripe rejects it otherwise.
                  payment_intent_data: {
                    setup_future_usage: "off_session",
                  },
                  // Sync collected shipping/name back to the Customer
                  // so /shop/me reflects the latest. customer_update
                  // requires `customer` to be set.
                  customer_update: {
                    shipping: "auto",
                    address: "auto",
                    name: "auto",
                  },
                }
              : customerEmail
                ? { customer_email: customerEmail }
                : {}),
            line_items: items.map((it) => ({
              price: it.priceId,
              quantity: it.quantity,
            })),
            success_url: successUrl,
            cancel_url: cancelUrl,
            // In-store pickup orders are collected at a location — Stripe
            // must NOT prompt for a shipping address (the snapshot stays
            // null and the order runs the pickup lifecycle instead).
            ...(isPickup
              ? {}
              : {
                  shipping_address_collection: {
                    allowed_countries: ["US"],
                  },
                }),
            phone_number_collection: { enabled: true },
            metadata: sessionMetadata,
            // Penn Home Medical Supply cash-pay shop never collects sales tax in v1 —
            // CPAP supplies are usually tax-exempt as durable medical
            // equipment, and Stripe Tax can be enabled later in the
            // dashboard without code changes.
            automatic_tax: { enabled: false },
          },
          { idempotencyKey, ...connectOptions },
        );
      }
    } catch (err) {
      req.log?.error(
        { ...stripeErrLogFields(err) },
        "stripe checkout.sessions.create failed",
      );
      // No Stripe session was created, so there's nothing to attach the
      // holds to and they'd otherwise leak until TTL. Release them now so
      // the reserved stock frees immediately. Best-effort (never throws).
      if (reservationOrgId && reservationIds.length > 0) {
        await releaseReservationIds(reservationOrgId, reservationIds, req.log);
      }
      res.status(502).json({
        error: "stripe_create_failed",
        message:
          "Couldn't start checkout. Please try again in a moment, or use the insurance flow.",
      });
      return;
    }

    if (!session.url) {
      // Stripe always returns a URL for hosted Checkout in payment
      // mode, but TypeScript can't prove it. Treat a missing URL as a
      // bug we want to catch loudly rather than silently.
      req.log?.error({ sessionId: session.id }, "stripe session has no url");
      if (reservationOrgId && reservationIds.length > 0) {
        await releaseReservationIds(reservationOrgId, reservationIds, req.log);
      }
      res.status(502).json({ error: "stripe_create_failed" });
      return;
    }

    // Stamp the new session id onto the holds so the webhook can later
    // consume (paid) or release (expired/failed) them. Best-effort — a
    // failure here just means the holds expire via TTL instead of being
    // resolved precisely; never blocks the checkout response.
    if (reservationOrgId && reservationIds.length > 0) {
      await attachSessionToReservations(
        reservationOrgId,
        reservationIds,
        session.id,
        req.log,
      );
    }

    // Mirror the session into shop_orders as a fresh `pending` row.
    // INSERT-or-IGNORE on conflict (`ignoreDuplicates: true`): a plain
    // `.upsert()` would overwrite EVERY column on conflict, including
    // resetting `status` back to "pending" — so a webhook that had
    // already advanced the row to paid/expired/failed would be silently
    // reverted, hiding the order from history and the returns flow. The
    // status (and the rest of the row) is only ever written on the
    // initial insert; later lifecycle transitions own the row. Mirrors
    // the quick-checkout mirror-upsert. (`status` is the source of truth
    // here; we deliberately do not re-touch `updated_at` on conflict.)
    // attachSignedIn allows guest checkout, so req.orgId may be unset;
    // fall back to the seed tenant (single-tenant bridge) for guests.
    const orgId = req.orgId ?? (await resolveSeedOrgId());
    if (!orgId) {
      res.status(503).json({ error: "tenant_unavailable" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const orderRow = {
      stripe_session_id: session.id,
      status: "pending" as const,
      cart_hash: cartHash as string | null,
      fulfillment_method: fulfillmentMethod,
      ...(pickupLocationId ? { pickup_location_id: pickupLocationId } : {}),
      ...(req.userCustomerId ? { customer_id: req.userCustomerId } : {}),
      updated_at: new Date().toISOString(),
    };
    const { error: upsertErr } = await supabase
      .from("shop_orders")
      .upsert(orderRow, {
        onConflict: "stripe_session_id",
        ignoreDuplicates: true,
      });
    if (upsertErr) {
      // `onConflict: stripe_session_id` only swallows a session-id collision.
      // A returning customer re-checking-out an IDENTICAL cart yields a NEW
      // Stripe session but the SAME cart_hash, so the mirror insert trips the
      // separate partial unique index `shop_orders_cart_hash_unique_idx`
      // (migration 0062, WHERE cart_hash IS NOT NULL) with Postgres 23505.
      // Narrow to THAT constraint — any other 23505 is an unexpected uniqueness
      // bug and must still 500 (and not be mislabelled a cart_hash collision).
      const isCartHashConflict =
        upsertErr.code === "23505" &&
        /cart_hash/i.test(
          `${upsertErr.message ?? ""} ${upsertErr.details ?? ""}`,
        );
      if (isCartHashConflict) {
        // Re-insert WITHOUT cart_hash so THIS session still gets its own
        // shop_orders row (a NULL cart_hash is exempt from the partial index).
        // The checkout-success page looks the order up by stripe_session_id
        // immediately and 404s if there's no local row; markPaid later owns the
        // same row by that key. We drop only the cart_hash de-dupe signal.
        const { error: retryErr } = await supabase
          .from("shop_orders")
          .upsert(
            { ...orderRow, cart_hash: null },
            { onConflict: "stripe_session_id", ignoreDuplicates: true },
          );
        if (retryErr) {
          req.log?.error(
            { err: retryErr, sessionId: session.id },
            "shop checkout: cart_hash-free order mirror retry failed",
          );
          res.status(500).json({ error: "shop_order_persist_failed" });
          return;
        }
        req.log?.info(
          { sessionId: session.id },
          "shop checkout: duplicate cart_hash; mirrored order without cart_hash",
        );
      } else {
        req.log?.error(
          { err: upsertErr, sessionId: session.id },
          "shop checkout: shop_orders upsert failed",
        );
        res.status(500).json({ error: "shop_order_persist_failed" });
        return;
      }
    }

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  },
);

export default router;
