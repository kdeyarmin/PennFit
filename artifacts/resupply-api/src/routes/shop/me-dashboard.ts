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
//   * latestOrder         — most-recent insurance fulfillment when the
//                            signed-in email resolves to exactly one
//                            patient chart; otherwise the latest paid
//                            historical shop_orders row (legacy cash-pay).
//                            Home banner links to /account.
//   * activeSubscriptions — always 0 (Subscribe & Save takes no new
//                            writes).
//   * pendingOrders       — backlog of unshipped legacy shop_orders plus
//                            queued insurance fulfillments (when linked).
//   * abandonedCart       — always null. Abandoned cash-pay carts must
//                            not nudge "ready to order" on the home page.
//
// Designed to be called once on the home page when the user is
// signed in. Returns a stable JSON shape even when the user has no
// orders — the home banner just renders whichever fields are non-null.

import { Router, type IRouter } from "express";

import { type Json, getOrgScopedClient } from "@workspace/resupply-db";

import { resolvePatientIdForCustomer } from "../../lib/shop-customer/resolve-patient";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

type DashboardLatestOrder = {
  id: string;
  sessionId: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
};

function parseShipmentMetadata(json: Json | null): {
  carrier: string | null;
  tracking: string | null;
} {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { carrier: null, tracking: null };
  }
  const row = json as Record<string, unknown>;
  return {
    carrier: typeof row.carrier === "string" ? row.carrier : null,
    tracking: typeof row.tracking === "string" ? row.tracking : null,
  };
}

function orderActivityAt(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

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

  const patientIdPromise = resolvePatientIdForCustomer(supabase, customerId);

  // Legacy cash-pay reads stay for historical rows. Insurance patients
  // also get fulfillment-backed status when email resolves to one chart.
  const [latestOrderRes, pendingOrdersRes, patientId] = await Promise.all([
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
    patientIdPromise,
  ]);
  if (latestOrderRes.error) throw latestOrderRes.error;
  if (pendingOrdersRes.error) throw pendingOrdersRes.error;

  let latestFulfillment: DashboardLatestOrder | null = null;
  let pendingFulfillments = 0;
  if (patientId) {
    const [latestFulfillmentRes, pendingFulfillmentsRes] = await Promise.all([
      supabase
        .from("fulfillments")
        .select(
          "id, status, created_at, shipped_at, delivered_at, shipment_metadata",
        )
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("fulfillments")
        .select("*", { count: "exact", head: true })
        .eq("patient_id", patientId)
        .is("shipped_at", null)
        .is("delivered_at", null)
        .not("status", "in", "(cancelled,canceled)"),
    ]);
    if (latestFulfillmentRes.error) throw latestFulfillmentRes.error;
    if (pendingFulfillmentsRes.error) throw pendingFulfillmentsRes.error;

    pendingFulfillments = pendingFulfillmentsRes.count ?? 0;
    const row = latestFulfillmentRes.data;
    if (row) {
      const tracking = parseShipmentMetadata(row.shipment_metadata);
      latestFulfillment = {
        id: row.id,
        sessionId: "",
        paidAt: row.created_at,
        shippedAt: row.shipped_at,
        deliveredAt: row.delivered_at,
        trackingCarrier: tracking.carrier,
        trackingNumber: tracking.tracking,
      };
    }
  }

  const latestShopOrderRow = latestOrderRes.data;
  const latestShopOrder: DashboardLatestOrder | null = latestShopOrderRow
    ? {
        id: latestShopOrderRow.id,
        sessionId: latestShopOrderRow.stripe_session_id,
        paidAt: latestShopOrderRow.paid_at,
        shippedAt: latestShopOrderRow.shipped_at,
        deliveredAt: latestShopOrderRow.delivered_at,
        trackingCarrier: latestShopOrderRow.tracking_carrier,
        trackingNumber: latestShopOrderRow.tracking_number,
      }
    : null;

  const latestOrder: DashboardLatestOrder | null =
    latestFulfillment && latestShopOrder
      ? orderActivityAt(
            latestFulfillment.deliveredAt ??
              latestFulfillment.shippedAt ??
              latestFulfillment.paidAt,
          ) >=
          orderActivityAt(
            latestShopOrder.deliveredAt ??
              latestShopOrder.shippedAt ??
              latestShopOrder.paidAt ??
              latestShopOrderRow?.created_at,
          )
        ? latestFulfillment
        : latestShopOrder
      : (latestFulfillment ?? latestShopOrder);

  res.json({
    nextShipment: null,
    eligibility: { eligibleNow: [], soonest: null },
    latestOrder,
    activeSubscriptions: 0,
    pendingOrders: (pendingOrdersRes.count ?? 0) + pendingFulfillments,
    abandonedCart: null,
  });
});

export default router;
