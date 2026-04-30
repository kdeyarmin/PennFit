// /shop/me/orders/* — paginated order history + per-order edit
// endpoints for the signed-in shopper.
//
// Endpoints in this module:
//   * GET  /shop/me/orders                          — paginated history
//   * POST /shop/me/orders/:orderId/shipping-address — pre-shipment
//                                                      address correction
//                                                      (returns 409 once
//                                                      shipped_at IS NOT
//                                                      NULL — strict
//                                                      guard, customers
//                                                      can NOT override
//                                                      after ship; only
//                                                      admins can)
//
// Why we keep this in one file:
//   Both endpoints are scoped by the same "rows where clerk_user_id
//   matches the caller" rule. Centralising the WHERE clause + the
//   row projection avoids the most common scope-bleed bug — a new
//   endpoint forgetting the clerkUserId filter and exposing other
//   shoppers' orders.
//
// What GET returns:
//   Each order summary, plus its line items (qty × product). The
//   line items come from `shop_order_items`, which the Stripe webhook
//   populated when the order flipped to `paid`. Product display
//   names are looked up in ONE bulk Stripe call per page (not one
//   per line) and cached in-process for 60s. If Stripe is offline
//   we degrade to "Product <id>" rather than 5xx — the order list
//   itself is the contract with the customer; product naming is a
//   nice-to-have that should never break "show me what I bought".
//
//   Plus tracking + shipping-address fields (W3 T-C6/T-C7) so the
//   shop-orders page can render the Track link and the "Edit address"
//   button without a second round-trip.
//
// Pagination:
//   Composite cursor (paidAt + id) shared with the review endpoints.
//   Necessary because two orders paid in the same second would skip
//   the rest of the tied set under a `paidAt < cursor` filter.
//
// Privacy:
//   Both handlers ONLY ever return / mutate rows where
//   `clerk_user_id` matches the caller's Clerk user id. This is the
//   core scope rule — no admin override path through this module.

import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  getDbPool,
  shopOrderItems,
  shopOrders,
} from "@workspace/resupply-db";
import type { SavedShippingAddress } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  encodeCompositeCursor,
  parseCompositeCursor,
} from "../../lib/cursor";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";

const router: IRouter = Router();

const querySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.min(50, Math.max(1, parseInt(v, 10))) : 20)),
  cursor: z.string().optional(),
});

interface ProductCacheEntry {
  fetchedAt: number;
  names: Map<string, string>;
}

const PRODUCT_NAME_CACHE_TTL_MS = 60_000;
let productNameCache: ProductCacheEntry | null = null;

// Carrier → tracking-URL template. Keys are normalised to lowercase
// (carrier names entered in the admin tool may be mixed-case). Each
// template gets `{n}` substituted with the tracking number.
//
// Why we hardcode a small set rather than a generic "search the
// internet" approach:
//   * We control the carriers PennPaps actually uses. Anything we
//     don't recognise falls back to displaying the number with no
//     link — safer than emitting a guessed URL that 404s.
//   * URL formats DO change occasionally; this list is the one
//     place to update.
const TRACKING_URL_TEMPLATES: Record<string, string> = {
  ups: "https://www.ups.com/track?tracknum={n}",
  usps: "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1={n}",
  fedex: "https://www.fedex.com/fedextrack/?trknbr={n}",
  dhl: "https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id={n}",
  ontrac: "https://www.ontrac.com/trackingres.asp?tracking_number={n}",
};

function computeTrackingUrl(
  carrier: string | null,
  number: string | null,
): string | null {
  if (!carrier || !number) return null;
  const tpl = TRACKING_URL_TEMPLATES[carrier.toLowerCase().trim()];
  if (!tpl) return null;
  // encodeURIComponent guards against admin-entered numbers that
  // contain reserved URL characters (very rare for tracking numbers
  // but free safety for the cost of one function call).
  return tpl.replace("{n}", encodeURIComponent(number));
}

// UUID-formatted text id; matches the gen_random_uuid()::text values
// in shop_orders. Same regex used by the admin router.
const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateOrderId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return ORDER_ID_RE.test(raw) ? raw : null;
}

// Customer-facing address shape. Mirrors SavedShippingAddress and the
// admin's body schema. We deliberately re-declare here rather than
// importing the admin one because (a) the admin file lives under
// /admin and importing across that boundary would couple a customer
// route to admin internals, and (b) the duplication is small + obvious.
const addressBodySchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z
    .union([z.string().trim().max(200), z.null(), z.undefined()])
    .transform((v) => (v === undefined || v === "" ? null : v)),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(2).max(2),
  postalCode: z.string().trim().min(3).max(20),
  country: z.literal("US"),
});

router.get("/shop/me/orders", requireSignedIn, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { limit, cursor: rawCursor } = parsed.data;
  const cursor = parseCompositeCursor(rawCursor);
  if (!cursor.ok) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }

  const db = drizzle(getDbPool());

  // Only paid orders reach the history page. Pending / expired sessions
  // are operational noise the customer never asked to see; they'll be
  // re-presented through the /shop/quick-checkout flow if relevant.
  const baseFilter = and(
    eq(shopOrders.clerkUserId, req.userClerkId!),
    eq(shopOrders.status, "paid"),
  );
  // Composite cursor predicate: `paidAt < ts OR (paidAt = ts AND id < cursorId)`.
  // We sort by paidAt DESC (with id DESC as the tiebreak), so the
  // "older than the cursor" predicate is strict-less-than on the
  // composite key. Falsy cursor → no predicate (first page).
  const cursorClause =
    cursor.date && cursor.id
      ? or(
          lt(shopOrders.paidAt, cursor.date),
          and(eq(shopOrders.paidAt, cursor.date), lt(shopOrders.id, cursor.id)),
        )
      : undefined;

  const orderRows = await db
    .select({
      id: shopOrders.id,
      stripeSessionId: shopOrders.stripeSessionId,
      status: shopOrders.status,
      amountTotalCents: shopOrders.amountTotalCents,
      currency: shopOrders.currency,
      createdAt: shopOrders.createdAt,
      paidAt: shopOrders.paidAt,
      // W3 T-C6/T-C7: tracking + per-order address snapshot.
      shippingAddress: shopOrders.shippingAddress,
      trackingCarrier: shopOrders.trackingCarrier,
      trackingNumber: shopOrders.trackingNumber,
      shippedAt: shopOrders.shippedAt,
      deliveredAt: shopOrders.deliveredAt,
    })
    .from(shopOrders)
    .where(cursorClause ? and(baseFilter, cursorClause) : baseFilter)
    // ORDER BY paid_at DESC NULLS LAST is implicit in Postgres for DESC,
    // but every row in this query has status='paid' so paidAt is
    // guaranteed non-null by the application contract anyway.
    .orderBy(desc(shopOrders.paidAt), desc(shopOrders.id))
    .limit(limit + 1);

  const hasMore = orderRows.length > limit;
  const trimmed = hasMore ? orderRows.slice(0, limit) : orderRows;
  const lastItem = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && lastItem && lastItem.paidAt
      ? encodeCompositeCursor(lastItem.paidAt, lastItem.id)
      : null;

  // No orders → don't even hit the line-items table.
  if (trimmed.length === 0) {
    res.json({ orders: [], nextCursor: null });
    return;
  }

  const orderIds = trimmed.map((o) => o.id);
  const itemRows = await db
    .select({
      orderId: shopOrderItems.orderId,
      productId: shopOrderItems.productId,
      quantity: shopOrderItems.quantity,
      unitAmountCents: shopOrderItems.unitAmountCents,
      currency: shopOrderItems.currency,
    })
    .from(shopOrderItems)
    .where(inArray(shopOrderItems.orderId, orderIds));

  // Bulk product-name lookup. One Stripe call regardless of page
  // size (Stripe's products.list cap is 100 IDs per call; we cap our
  // page size at 50 so a single page never crosses the boundary, but
  // we still chunk defensively).
  const productIds = Array.from(
    new Set(itemRows.map((r) => r.productId).filter((v) => v.length > 0)),
  );
  const productNames = await fetchProductNames(productIds, req.log);

  // Group items by orderId for O(1) lookup during projection.
  const itemsByOrder = new Map<string, typeof itemRows>();
  for (const row of itemRows) {
    const list = itemsByOrder.get(row.orderId) ?? [];
    list.push(row);
    itemsByOrder.set(row.orderId, list);
  }

  res.json({
    orders: trimmed.map((o) => ({
      id: o.id,
      sessionId: o.stripeSessionId,
      status: o.status,
      amountTotalCents: o.amountTotalCents,
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
      paidAt: o.paidAt ? o.paidAt.toISOString() : null,
      // W3 T-C6/T-C7 fields. Every field is null for older orders
      // (pre-migration-0013) — the UI must treat null as "not yet
      // entered" rather than as a contract violation.
      shippingAddress: o.shippingAddress,
      tracking:
        o.trackingCarrier && o.trackingNumber
          ? {
              carrier: o.trackingCarrier,
              number: o.trackingNumber,
              url: computeTrackingUrl(o.trackingCarrier, o.trackingNumber),
            }
          : null,
      shippedAt: o.shippedAt ? o.shippedAt.toISOString() : null,
      deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
      // Convenience boolean for the UI: "is the customer still allowed
      // to edit the address?". The same predicate is enforced server-
      // side in the POST handler below, so the UI flag is purely a
      // display hint — a stale `true` won't open a security hole.
      canEditAddress: o.shippedAt === null,
      items: (itemsByOrder.get(o.id) ?? []).map((it) => ({
        productId: it.productId,
        // Fallback name keeps the UI clean when the catalog has
        // dropped a SKU (or Stripe is unreachable). The id is
        // already a stable identifier so we surface it directly.
        productName:
          productNames.get(it.productId) ??
          `Product ${it.productId.slice(0, 12)}`,
        quantity: it.quantity,
        unitAmountCents: it.unitAmountCents,
        currency: it.currency,
      })),
    })),
    nextCursor,
  });
});

// ---------------------------------------------------------------------
// POST /shop/me/orders/:orderId/shipping-address
// ---------------------------------------------------------------------
// Customer-side address correction, allowed ONLY while the parcel
// hasn't been handed to the carrier. Once shipped_at is set the
// customer must use the contact-support flow (an admin then uses
// PATCH /admin/shop/orders/:orderId/shipping-address to update the
// address-of-record for return purposes).
//
// Concurrency / race notes:
//   The UPDATE filter includes `shipped_at IS NULL` directly so that
//   if an admin enters tracking between our SELECT and our UPDATE the
//   second wins cleanly (zero rows updated → 409). We deliberately do
//   not use a transaction here — the WHERE-based optimistic check is
//   sufficient and avoids the connection-hold cost.
router.post(
  "/shop/me/orders/:orderId/shipping-address",
  requireSignedIn,
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const parsed = addressBodySchema.safeParse(req.body);
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
    const address: SavedShippingAddress = {
      line1: parsed.data.line1,
      line2: parsed.data.line2 ?? null,
      city: parsed.data.city,
      // State codes are normalised to uppercase so the saved value
      // matches the storefront's address-display + admin filters.
      state: parsed.data.state.toUpperCase(),
      postalCode: parsed.data.postalCode,
      country: "US",
    };

    const db = drizzle(getDbPool());
    // Pre-check: load the row to disambiguate "doesn't exist", "not
    // yours", and "already shipped". Without this the UPDATE-only
    // path would collapse all three into a single 404, which is a
    // worse customer experience.
    const existingRows = await db
      .select({
        id: shopOrders.id,
        clerkUserId: shopOrders.clerkUserId,
        status: shopOrders.status,
        shippedAt: shopOrders.shippedAt,
      })
      .from(shopOrders)
      .where(eq(shopOrders.id, orderId))
      .limit(1);
    const existing = existingRows[0];
    // 404 covers both "no such order" and "order belongs to another
    // shopper" — collapsing them avoids leaking the existence of a
    // foreign order id to a brute-force attacker.
    if (!existing || existing.clerkUserId !== req.userClerkId) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (existing.status !== "paid") {
      res.status(409).json({
        error: "order_not_paid",
        currentStatus: existing.status,
      });
      return;
    }
    if (existing.shippedAt !== null) {
      res.status(409).json({ error: "order_already_shipped" });
      return;
    }

    // The WHERE clause re-asserts the not-yet-shipped invariant so
    // a race with the admin-tracking endpoint can't slip through.
    // Returning the row gives the UI an updated projection without
    // a follow-up GET.
    const updated = await db
      .update(shopOrders)
      .set({
        shippingAddress: address,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(shopOrders.id, orderId),
          eq(shopOrders.clerkUserId, req.userClerkId!),
          eq(shopOrders.status, "paid"),
          isNull(shopOrders.shippedAt),
        ),
      )
      .returning({
        id: shopOrders.id,
        shippingAddress: shopOrders.shippingAddress,
        shippedAt: shopOrders.shippedAt,
      });
    const row = updated[0];
    if (!row) {
      // Admin entered tracking between our SELECT and our UPDATE.
      res.status(409).json({ error: "order_already_shipped" });
      return;
    }
    req.log?.info?.(
      { orderId, clerkUserId: req.userClerkId },
      "shop/me/orders: shipping address updated by customer",
    );
    res.json({
      order: {
        id: row.id,
        shippingAddress: row.shippingAddress,
        shippedAt: row.shippedAt ? row.shippedAt.toISOString() : null,
        canEditAddress: row.shippedAt === null,
      },
    });
  },
);

async function fetchProductNames(
  ids: string[],
  log: { warn?: (...args: unknown[]) => void } | undefined,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  // Cache hit: every requested id was already resolved within the
  // TTL. Reusing the cache eliminates a round-trip on the common
  // "user pages through a long order history" path.
  if (
    productNameCache &&
    Date.now() - productNameCache.fetchedAt < PRODUCT_NAME_CACHE_TTL_MS &&
    ids.every((id) => productNameCache!.names.has(id))
  ) {
    return productNameCache.names;
  }

  const config = readStripeConfigOrNull();
  if (!config) {
    // Preview / dev path: Stripe isn't configured so we can't look
    // up names. Returning an empty map causes the projection to
    // fall back to "Product <id>" — same UX as a Stripe outage,
    // which is what we want.
    return new Map();
  }
  const stripe = getStripeClient(config);
  const out = new Map<string, string>();
  try {
    // products.list with `ids` does the bulk lookup in a single call.
    // Stripe caps at 100 ids per request; chunk defensively in case
    // a future page-size change pushes past that.
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100);
      const res = await stripe.products.list({ ids: slice, limit: 100 });
      for (const p of res.data) {
        if (p.name) out.set(p.id, p.name);
      }
    }
  } catch (err) {
    log?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      "shop/me/orders: stripe product name lookup failed (non-fatal)",
    );
    return out; // Whatever we managed to collect; rest fall back.
  }

  productNameCache = { fetchedAt: Date.now(), names: out };
  return out;
}

export default router;
