// /shop/me/dashboard — single-fetch status digest for the signed-in
// home banner.
//
// What it returns (read-only, never errors when authenticated):
//   * nextShipment        — soonest currentPeriodEnd from active
//                            subscriptions (subscribe-and-ship).
//   * latestOrder         — most-recent paid order with optional
//                            tracking + delivery state.
//   * activeSubscriptions — count of `status='active'` subs (after
//                            "active" filter; trialing also counts).
//   * pendingOrders       — count of `status='paid' AND shipped_at IS NULL`
//                            for the user (their backlog).
//   * cartItemCount       — number of items in the abandoned-cart
//                            snapshot if the user left items behind
//                            on another device.
//
// Designed to be called once on the home page when the user is
// signed in. All four sub-queries are O(rows-by-user) and indexed.
// Returns a stable JSON shape even when the user has no orders /
// subscriptions / cart — the home banner just renders whichever
// fields are non-null.

import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  shopAbandonedCarts,
  shopOrders,
  shopSubscriptions,
} from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

router.get("/shop/me/dashboard", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  const db = drizzle(getDbPool());
  const now = new Date();

  // Soonest upcoming shipment — pick the nearest `currentPeriodEnd`
  // across the user's active/trialing subscriptions. We don't need
  // the full row, just the date + a representative item label.
  const subRows = await db
    .select({
      id: shopSubscriptions.id,
      status: shopSubscriptions.status,
      currentPeriodEnd: shopSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: shopSubscriptions.cancelAtPeriodEnd,
      items: shopSubscriptions.items,
    })
    .from(shopSubscriptions)
    .where(eq(shopSubscriptions.customerId, customerId));

  const liveStatuses = new Set(["active", "trialing", "past_due"]);
  const liveSubs = subRows.filter((r) => liveStatuses.has(r.status));
  const upcoming = liveSubs
    .filter((r) => r.currentPeriodEnd && r.currentPeriodEnd > now)
    .sort(
      (a, b) =>
        (a.currentPeriodEnd?.getTime() ?? Infinity) -
        (b.currentPeriodEnd?.getTime() ?? Infinity),
    )[0];

  const nextShipment = upcoming
    ? {
        subscriptionId: upcoming.id,
        date: upcoming.currentPeriodEnd!.toISOString(),
        firstItemName: upcoming.items?.[0]?.name ?? null,
        cancelAtPeriodEnd: upcoming.cancelAtPeriodEnd ?? false,
      }
    : null;

  // Latest paid order — gives the home banner enough to say
  // "Order shipped Apr 22 · UPS 1Z…" or "Awaiting tracking".
  const orderRows = await db
    .select({
      id: shopOrders.id,
      sessionId: shopOrders.stripeSessionId,
      status: shopOrders.status,
      paidAt: shopOrders.paidAt,
      shippedAt: shopOrders.shippedAt,
      deliveredAt: shopOrders.deliveredAt,
      trackingCarrier: shopOrders.trackingCarrier,
      trackingNumber: shopOrders.trackingNumber,
      createdAt: shopOrders.createdAt,
    })
    .from(shopOrders)
    .where(
      and(eq(shopOrders.customerId, customerId), eq(shopOrders.status, "paid")),
    )
    .orderBy(desc(shopOrders.paidAt))
    .limit(1);

  const latestOrder = orderRows[0]
    ? {
        id: orderRows[0].id,
        sessionId: orderRows[0].sessionId,
        paidAt: orderRows[0].paidAt?.toISOString() ?? null,
        shippedAt: orderRows[0].shippedAt?.toISOString() ?? null,
        deliveredAt: orderRows[0].deliveredAt?.toISOString() ?? null,
        trackingCarrier: orderRows[0].trackingCarrier,
        trackingNumber: orderRows[0].trackingNumber,
      }
    : null;

  // Pending shipments count — orders that are paid but not yet
  // shipped. Drives the "1 order awaiting shipment" pill.
  const [pendingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopOrders)
    .where(
      and(
        eq(shopOrders.customerId, customerId),
        eq(shopOrders.status, "paid"),
        isNull(shopOrders.shippedAt),
      ),
    );

  // Stale cart on another device.
  const cartRows = await db
    .select({
      items: shopAbandonedCarts.items,
      updatedAt: shopAbandonedCarts.updatedAt,
      recoveredAt: shopAbandonedCarts.recoveredAt,
      clearedAt: shopAbandonedCarts.clearedAt,
    })
    .from(shopAbandonedCarts)
    .where(eq(shopAbandonedCarts.customerId, customerId))
    .limit(1);

  const cartRow = cartRows[0];
  const stillAbandoned =
    cartRow &&
    !cartRow.recoveredAt &&
    !cartRow.clearedAt &&
    Array.isArray(cartRow.items) &&
    cartRow.items.length > 0;

  res.json({
    nextShipment,
    latestOrder,
    activeSubscriptions: liveSubs.length,
    pendingOrders: pendingRow?.count ?? 0,
    abandonedCart: stillAbandoned
      ? {
          itemCount: cartRow!.items.length,
          updatedAt: cartRow!.updatedAt.toISOString(),
        }
      : null,
  });
});

export default router;
