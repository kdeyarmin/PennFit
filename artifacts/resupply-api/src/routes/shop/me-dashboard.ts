// /shop/me/dashboard — single-fetch status digest for the signed-in
// home banner.
//
// What it returns (read-only, never errors when authenticated):
//   * nextShipment        — soonest currentPeriodEnd from active
//                            subscriptions (subscribe-and-ship), with
//                            a `daysUntil` countdown (Phase A.1).
//   * eligibility         — Phase A.1 eligibility-claim payload:
//                            { eligibleNow: [items past their period
//                            end], soonest: { firstItemName,
//                            daysUntil } } so the dashboard banner can
//                            say "ready now" or "eligible in N days".
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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

interface SubscriptionItem {
  name?: string;
}

const router: IRouter = Router();

router.get("/shop/me/dashboard", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const now = new Date();
  const nowIso = now.toISOString();

  // All four reads run concurrently — they're independent and indexed
  // on customer_id.
  const [subsRes, latestOrderRes, pendingOrdersRes, cartRes] = await Promise.all(
    [
      supabase
        .schema("resupply")
        .from("shop_subscriptions")
        .select("id, status, current_period_end, cancel_at_period_end, items")
        .eq("customer_id", customerId),
      supabase
        .schema("resupply")
        .from("shop_orders")
        .select(
          "id, stripe_session_id, status, paid_at, shipped_at, delivered_at, tracking_carrier, tracking_number, created_at",
        )
        .eq("customer_id", customerId)
        .eq("status", "paid")
        .order("paid_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("shop_orders")
        .select("*", { count: "exact", head: true })
        .eq("customer_id", customerId)
        .eq("status", "paid")
        .is("shipped_at", null),
      supabase
        .schema("resupply")
        .from("shop_abandoned_carts")
        .select("items, updated_at, recovered_at, cleared_at")
        .eq("customer_id", customerId)
        .limit(1)
        .maybeSingle(),
    ],
  );
  if (subsRes.error) throw subsRes.error;
  if (latestOrderRes.error) throw latestOrderRes.error;
  if (pendingOrdersRes.error) throw pendingOrdersRes.error;
  if (cartRes.error) throw cartRes.error;

  // Soonest upcoming shipment — pick the nearest `currentPeriodEnd`
  // across the user's active/trialing subscriptions. We don't need
  // the full row, just the date + a representative item label.
  const liveStatuses = new Set(["active", "trialing", "past_due"]);
  const liveSubs = (subsRes.data ?? []).filter((r) =>
    liveStatuses.has(r.status),
  );
  const itemsOf = (raw: unknown): SubscriptionItem[] =>
    Array.isArray(raw) ? (raw as SubscriptionItem[]) : [];
  const upcoming = liveSubs
    .filter((r) => r.current_period_end && r.current_period_end > nowIso)
    .sort((a, b) =>
      (a.current_period_end ?? "").localeCompare(b.current_period_end ?? ""),
    )[0];

  const nextShipment = upcoming
    ? {
        subscriptionId: upcoming.id,
        date: upcoming.current_period_end!,
        // Phase A.1 — countdown to the next eligible date. Always >= 0;
        // computed against the same `now` used for the cycle filter
        // above so the two fields agree on "today" within a single
        // request.
        daysUntil: Math.max(
          0,
          Math.ceil(
            (new Date(upcoming.current_period_end!).getTime() - now.getTime()) /
              (24 * 60 * 60 * 1000),
          ),
        ),
        firstItemName: itemsOf(upcoming.items)[0]?.name ?? null,
        cancelAtPeriodEnd: upcoming.cancel_at_period_end ?? false,
      }
    : null;

  const eligibleNow = liveSubs
    .filter((r) => !r.cancel_at_period_end)
    .filter((r) => r.current_period_end && r.current_period_end <= nowIso)
    .map((r) => ({
      subscriptionId: r.id,
      firstItemName: itemsOf(r.items)[0]?.name ?? null,
    }));
  const eligibility = {
    eligibleNow,
    soonest: nextShipment
      ? {
          firstItemName: nextShipment.firstItemName,
          daysUntil: nextShipment.daysUntil,
        }
      : null,
  };

  const latestOrderRow = latestOrderRes.data;
  const latestOrder = latestOrderRow
    ? {
        id: latestOrderRow.id,
        sessionId: latestOrderRow.stripe_session_id,
        paidAt: latestOrderRow.paid_at,
        shippedAt: latestOrderRow.shipped_at,
        deliveredAt: latestOrderRow.delivered_at,
        trackingCarrier: latestOrderRow.tracking_carrier,
        trackingNumber: latestOrderRow.tracking_number,
      }
    : null;

  const cartRow = cartRes.data;
  const cartItems = cartRow ? itemsOf(cartRow.items) : [];
  const stillAbandoned =
    cartRow &&
    !cartRow.recovered_at &&
    !cartRow.cleared_at &&
    cartItems.length > 0;

  res.json({
    nextShipment,
    eligibility,
    latestOrder,
    activeSubscriptions: liveSubs.length,
    pendingOrders: pendingOrdersRes.count ?? 0,
    abandonedCart: stillAbandoned
      ? {
          itemCount: cartItems.length,
          updatedAt: cartRow!.updated_at,
        }
      : null,
  });
});

export default router;
