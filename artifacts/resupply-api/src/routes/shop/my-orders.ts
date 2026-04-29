// GET /shop/me/orders — paginated order history for the signed-in
// shopper. Latest first.
//
// What we return:
//   Each order summary, plus its line items (qty × product). The
//   line items come from `shop_order_items`, which the Stripe webhook
//   populated when the order flipped to `paid`. Product display
//   names are looked up in ONE bulk Stripe call per page (not one
//   per line) and cached in-process for 60s. If Stripe is offline
//   we degrade to "Product <id>" rather than 5xx — the order list
//   itself is the contract with the customer; product naming is a
//   nice-to-have that should never break "show me what I bought".
//
// Pagination:
//   Composite cursor (paidAt + id) shared with the review endpoints.
//   Necessary because two orders paid in the same second would skip
//   the rest of the tied set under a `paidAt < cursor` filter.
//
// Privacy:
//   The handler ONLY ever returns rows where `clerk_user_id` matches
//   the caller's Clerk user id. This is the core scope rule — no
//   admin override path through this endpoint.

import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  getDbPool,
  shopOrderItems,
  shopOrders,
} from "@workspace/resupply-db";

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
