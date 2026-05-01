// /shop/me/export — customer self-service data export.
//
// Returns every cash-pay datum we hold for the calling Clerk user as
// a single JSON document, suitable for download. Surfaces:
//   * profile (display name + email + saved address)
//   * communication preferences
//   * orders + their line items + tracking + delivery state
//   * subscriptions (auto-ship)
//   * returns / RMAs
//   * reviews authored
//   * abandoned cart snapshot (if any)
//
// Privacy posture:
//   * No PHI on this surface — the cash-pay shop has no PHI per the
//     project's design split (PHI lives in the resupply.* schema's
//     `patients` table, which is keyed by PACware patient id, not by
//     Clerk user id). This export is therefore complete coverage for
//     the consumer-side data we hold.
//   * Saved card crumbs are returned (brand + last4 + exp month/year)
//     since those are already stored locally for display; full PAN /
//     CVC have never been in our possession (Stripe Hosted Checkout
//     keeps PCI scope on Stripe).
//   * Stripe customer / payment-intent IDs are included because they
//     ARE the customer's data and may be useful for support.
//
// Compliance: this endpoint is the technical backstop for "right to
// access" requests under CCPA / CPRA / Washington's MHMD Act. The
// admin-side delete path is separate (and harder — closes Stripe
// Customer + scrubs local rows; out of scope for this slice).

import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  shopAbandonedCarts,
  shopCustomers,
  shopOrderItems,
  shopOrders,
  shopReturns,
  shopReviews,
  shopSubscriptions,
} from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

router.get("/shop/me/export", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId!;
  const db = drizzle(getDbPool());

  const [customers, orders, items, subs, returns, reviews, carts] =
    await Promise.all([
      db
        .select()
        .from(shopCustomers)
        .where(eq(shopCustomers.customerId, customerId))
        .limit(1),
      db
        .select()
        .from(shopOrders)
        .where(eq(shopOrders.customerId, customerId))
        .orderBy(desc(shopOrders.createdAt)),
      db
        .select()
        .from(shopOrderItems)
        .where(eq(shopOrderItems.customerId, customerId)),
      db
        .select()
        .from(shopSubscriptions)
        .where(eq(shopSubscriptions.customerId, customerId))
        .orderBy(desc(shopSubscriptions.createdAt)),
      db
        .select()
        .from(shopReturns)
        .where(eq(shopReturns.customerId, customerId))
        .orderBy(desc(shopReturns.createdAt)),
      db
        .select()
        .from(shopReviews)
        .where(eq(shopReviews.customerId, customerId)),
      db
        .select()
        .from(shopAbandonedCarts)
        .where(eq(shopAbandonedCarts.customerId, customerId))
        .limit(1),
    ]);

  const itemsByOrder = new Map<string, typeof items>();
  for (const it of items) {
    const list = itemsByOrder.get(it.orderId) ?? [];
    list.push(it);
    itemsByOrder.set(it.orderId, list);
  }

  const exportedAt = new Date().toISOString();
  const filename = `pennpaps-export-${customerId.slice(-8)}-${exportedAt
    .slice(0, 10)
    .replace(/-/g, "")}.json`;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );

  res.send(
    JSON.stringify(
      {
        exportedAt,
        customerId,
        profile: customers[0] ?? null,
        orders: orders.map((o) => ({
          ...o,
          items: itemsByOrder.get(o.id) ?? [],
        })),
        subscriptions: subs,
        returns,
        reviews,
        abandonedCart: carts[0] ?? null,
        notes: {
          coverage:
            "This file contains every record the PennPaps cash-pay shop holds for your account.",
          phi:
            "Insurance / Rx / clinical data lives in a separate system and is not included here. Contact support@pennpaps.com to request that data.",
        },
      },
      null,
      2,
    ),
  );
});

export default router;
