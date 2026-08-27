// /shop/me/dashboard — single-fetch status digest for the signed-in
// home banner.
//
// What it returns (read-only, never errors when authenticated):
//   * nextShipment        — always null. Cash-pay Subscribe & Save is
//                            retired; historical `shop_subscriptions`
//                            rows must not surface as upcoming ships.
//   * eligibility         — always empty. Same reason: do not nudge
//                            insurance reorder from retired auto-ship
//                            period ends.
//   * latestOrder         — most-recent paid shop_orders row with
//                            optional tracking + delivery state
//                            (historical cash-pay or legacy rows only;
//                            home banner links to /account).
//   * activeSubscriptions — always 0 (Subscribe & Save takes no new
//                            writes).
//   * pendingOrders       — count of `status='paid' AND shipped_at IS NULL`
//                            for the user (their backlog).
//   * abandonedCart       — always null. Abandoned cash-pay carts must
//                            not nudge "ready to order" on the home page.
//
// Designed to be called once on the home page when the user is
// signed in. Returns a stable JSON shape even when the user has no
// orders — the home banner just renders whichever fields are non-null.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

router.get("/shop/me/dashboard", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);

  // Only historical order reads remain. Subscription / abandoned-cart
  // tables still exist for analytics but must not drive patient UX.
  const [latestOrderRes, pendingOrdersRes] = await Promise.all([
    supabase
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
      .from("shop_orders")
      .select("*", { count: "exact", head: true })
      .eq("customer_id", customerId)
      .eq("status", "paid")
      .is("shipped_at", null),
  ]);
  if (latestOrderRes.error) throw latestOrderRes.error;
  if (pendingOrdersRes.error) throw pendingOrdersRes.error;

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

  res.json({
    nextShipment: null,
    eligibility: { eligibleNow: [], soonest: null },
    latestOrder,
    activeSubscriptions: 0,
    pendingOrders: pendingOrdersRes.count ?? 0,
    abandonedCart: null,
  });
});

export default router;
