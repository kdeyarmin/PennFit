// /shop/me/dashboard — single-fetch status digest for the signed-in
// home banner.
//
// What it returns (read-only, never errors when authenticated):
//   * nextShipment        — soonest in-progress insurance episode
//                            `due_at` (outreach_pending / awaiting_response).
//                            Field names reuse the retired Subscribe &
//                            Save shape (`subscriptionId` = episode id).
//   * eligibility         — overdue episodes in `eligibleNow`; closest
//                            future (or overdue) in `soonest`.
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

import {
  IN_PROGRESS_EPISODE_STATUSES,
  buildInsuranceDueDigest,
  type EpisodeDueRow,
} from "../../lib/shop-customer/insurance-due-digest";
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

async function loadInsuranceDueDigest(
  supabase: ReturnType<typeof getOrgScopedClient>,
  patientId: string,
): Promise<ReturnType<typeof buildInsuranceDueDigest>> {
  const { data: episodes, error: episodesErr } = await supabase
    .from("episodes")
    .select("id, prescription_id, due_at")
    .eq("patient_id", patientId)
    .in("status", [...IN_PROGRESS_EPISODE_STATUSES])
    .order("due_at", { ascending: true })
    .limit(50);
  if (episodesErr) throw episodesErr;

  const rows = (episodes ?? []) as EpisodeDueRow[];
  if (rows.length === 0) {
    return buildInsuranceDueDigest([], new Map());
  }

  const rxIds = [...new Set(rows.map((r) => r.prescription_id))];
  const { data: prescriptions, error: rxErr } = await supabase
    .from("prescriptions")
    .select("id, item_sku")
    .in("id", rxIds);
  if (rxErr) throw rxErr;

  const skuByRx = new Map<string, string>();
  for (const rx of prescriptions ?? []) {
    if (rx.id && typeof rx.item_sku === "string") {
      skuByRx.set(rx.id, rx.item_sku);
    }
  }
  return buildInsuranceDueDigest(rows, skuByRx);
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
  let dueDigest = buildInsuranceDueDigest([], new Map());
  if (patientId) {
    const [latestFulfillmentRes, pendingFulfillmentsRes, digest] =
      await Promise.all([
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
        loadInsuranceDueDigest(supabase, patientId),
      ]);
    if (latestFulfillmentRes.error) throw latestFulfillmentRes.error;
    if (pendingFulfillmentsRes.error) throw pendingFulfillmentsRes.error;

    dueDigest = digest;
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
    nextShipment: dueDigest.nextShipment,
    eligibility: dueDigest.eligibility,
    latestOrder,
    activeSubscriptions: 0,
    pendingOrders: (pendingOrdersRes.count ?? 0) + pendingFulfillments,
    abandonedCart: null,
  });
});

export default router;
