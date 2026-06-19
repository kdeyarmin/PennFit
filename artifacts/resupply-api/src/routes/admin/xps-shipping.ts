// /admin/shipping/xps/* and /admin/shop/orders/:orderId/shipping/* —
// XPS Ship shipping-label integration.
//
// What this gives DME staff: instead of re-keying every patient's name
// and address into XPS's Webship UI, PennFit merges the order's
// shipping address straight onto the label. The flow mirrors XPS's
// stage-then-process REST model:
//
//   1. rates  — rate-shop carriers for the parcel (informational).
//   2. label  — Put Order into XPS with the merged patient/address data
//               and the chosen service, then resolve the booked shipment
//               (bookNumber + tracking) and store it. On success the
//               order is stamped shipped and the existing patient
//               shipping-notification (email/SMS/push) fires — exactly
//               like the manual /tracking flow.
//   3. sync   — re-resolve an order that XPS staged but hadn't processed
//               into a booked shipment yet.
//   4. label.pdf — stream the printable label bytes for the staff to
//               print.
//   5. void   — cancel a staged order / label.
//
// PHI posture: the label carries the patient's name + address (that's
// its purpose). We never log the address, the label bytes, or the XPS
// response bodies — only structural counts + order ids + carrier codes.
//
// Per-tenant: each DME brings its own XPS account, so the adapter is
// built from getEffectiveEnvForOrg(orgId) at call time (credential
// rotation honoured without a restart), never the bare process.env.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getOrgScopedClient,
  type Database,
  type SavedShippingAddress,
} from "@workspace/resupply-db";
import {
  createXpsShipAdapter,
  type XpsAddress,
  type XpsShipAdapter,
} from "@workspace/resupply-integrations-xps-ship";

import { requirePermission } from "../../middlewares/requireAdmin";
import { getEffectiveEnvForOrg } from "../../lib/app-config/store";
import { evaluatePaperworkGateForCustomer } from "../../lib/paperwork/require-signed-paperwork";
import { resolveSmsRecipientForShopOrder } from "../../lib/shop-orders-sms-resolver";
import { sendShippingNotificationIfNew } from "./shop-orders";

type ShopOrderUpdate = Database["resupply"]["Tables"]["shop_orders"]["Update"];

const router: IRouter = Router();

const ORDER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateOrderId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return ORDER_ID_RE.test(raw) ? raw : null;
}

// A parcel spec the UI supplies (DME staff weigh/measure the box). Weight
// in ounces keeps the form simple; the adapter converts to pounds for XPS.
const parcelSchema = z.object({
  weightOz: z
    .number()
    .positive()
    .max(70 * 16, "weight too large"),
  lengthIn: z.number().positive().max(108).nullish(),
  widthIn: z.number().positive().max(108).nullish(),
  heightIn: z.number().positive().max(108).nullish(),
});

const ratesBodySchema = z.object({
  parcel: parcelSchema,
  residential: z.boolean().optional(),
  carrierCode: z.string().trim().max(40).nullish(),
});

const labelBodySchema = z.object({
  parcel: parcelSchema,
  residential: z.boolean().optional(),
  shippingService: z.string().trim().min(1).max(60),
  contentDescription: z.string().trim().max(120).nullish(),
});

interface ShippingOrderRow {
  id: string;
  status: string;
  customerId: string | null;
  customerEmail: string | null;
  fulfillmentMethod: "ship" | "pickup";
  shippingAddress: SavedShippingAddress | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  xpsBookNumber: string | null;
  xpsLabelStatus: "staged" | "booked" | "voided" | null;
}

const SHIPPING_COLUMNS =
  "id, status, customer_id, customer_email, fulfillment_method, shipping_address_json, tracking_carrier, tracking_number, xps_book_number, xps_label_status";

function rowToShippingOrder(row: {
  id: string;
  status: string;
  customer_id: string | null;
  customer_email: string | null;
  fulfillment_method: "ship" | "pickup";
  shipping_address_json: unknown;
  tracking_carrier: string | null;
  tracking_number: string | null;
  xps_book_number: string | null;
  xps_label_status: "staged" | "booked" | "voided" | null;
}): ShippingOrderRow {
  return {
    id: row.id,
    status: row.status,
    customerId: row.customer_id,
    customerEmail: row.customer_email,
    fulfillmentMethod: row.fulfillment_method ?? "ship",
    shippingAddress:
      (row.shipping_address_json as SavedShippingAddress | null) ?? null,
    trackingCarrier: row.tracking_carrier,
    trackingNumber: row.tracking_number,
    xpsBookNumber: row.xps_book_number,
    xpsLabelStatus: row.xps_label_status,
  };
}

async function loadShippingOrder(
  orgId: string,
  orderId: string,
): Promise<ShippingOrderRow | null> {
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .from("shop_orders")
    .select(SHIPPING_COLUMNS)
    .eq("id", orderId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToShippingOrder(data) : null;
}

/** Build the XPS receiver from the order's address + customer identity. */
async function buildReceiver(
  orgId: string,
  order: ShippingOrderRow,
): Promise<XpsAddress | { error: "no_shipping_address" }> {
  const addr = order.shippingAddress;
  if (!addr || !addr.line1 || !addr.city || !addr.state || !addr.postalCode) {
    return { error: "no_shipping_address" };
  }

  let name = "";
  let email: string | null = order.customerEmail;
  const supabase = getOrgScopedClient(orgId);
  if (order.customerId) {
    const { data: cust } = await supabase
      .from("shop_customers")
      .select("display_name, email_lower")
      .eq("customer_id", order.customerId)
      .limit(1)
      .maybeSingle();
    if (cust?.display_name) name = cust.display_name;
    if (!email && cust?.email_lower) email = cust.email_lower;
  }
  if (!name) {
    // Fall back to the local-part of the order email so the carrier has
    // *a* recipient name to print (a label with a blank name can be
    // rejected). Never blank.
    name = (email?.split("@")[0] ?? "Recipient").slice(0, 60);
  }

  // Best-effort phone for carrier contact (gated by the SMS resolver's
  // own consent checks; returns null when unavailable). Never logged.
  let phone: string | null = null;
  try {
    const recipient = await resolveSmsRecipientForShopOrder({
      customerId: order.customerId,
      customerEmailFromOrder: order.customerEmail,
    });
    phone = recipient?.phoneE164 ?? null;
  } catch {
    // best-effort — leave phone null when the resolver is unavailable
  }

  return {
    name,
    address1: addr.line1,
    address2: addr.line2 ?? null,
    city: addr.city,
    state: addr.state,
    zip: addr.postalCode,
    country: addr.country || "US",
    phone,
    email,
  };
}

async function getAdapterForOrg(orgId: string): Promise<XpsShipAdapter> {
  const env = await getEffectiveEnvForOrg(orgId);
  return createXpsShipAdapter(env);
}

/** Map adapter error codes to HTTP responses consistently. */
function adapterErrorStatus(error: string): number {
  switch (error) {
    case "unavailable":
      return 503;
    case "auth_failed":
      return 502;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "invalid_request":
      return 422;
    default:
      return 502;
  }
}

/**
 * Resolve a staged XPS order into a booked shipment and persist it.
 * Shared by the `label` (post-create) and `sync` endpoints. On a booked
 * shipment it stamps shipped_at + tracking and fires the patient
 * notification, returning `{ status: "booked", shipment }`. When XPS
 * hasn't processed the order yet it returns `{ status: "staged" }`.
 */
async function resolveAndPersist(args: {
  orgId: string;
  order: ShippingOrderRow;
  adapter: XpsShipAdapter;
  log:
    | { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
    | undefined;
}): Promise<
  | {
      kind: "booked";
      carrier: string;
      trackingNumber: string;
      bookNumber: string;
    }
  | { kind: "staged" }
  | { kind: "error"; status: number; error: string }
> {
  const { orgId, order, adapter, log } = args;
  const found = await adapter.findShipmentByOrderId(order.id);
  if (!found.ok) {
    return {
      kind: "error",
      status: adapterErrorStatus(found.error),
      error: found.error,
    };
  }
  const shipment = found.value;
  if (!shipment || !shipment.bookNumber || !shipment.trackingNumber) {
    return { kind: "staged" };
  }

  const carrier = shipment.carrierCode ?? "XPS";
  const trackingChanged =
    order.trackingCarrier !== carrier ||
    order.trackingNumber !== shipment.trackingNumber;
  const nowIso = new Date().toISOString();
  const update: ShopOrderUpdate = {
    xps_book_number: shipment.bookNumber,
    xps_label_status: "booked",
    tracking_carrier: carrier,
    tracking_number: shipment.trackingNumber,
    shipping_service_code: shipment.serviceCode ?? null,
    shipped_at: nowIso,
    updated_at: nowIso,
  };
  if (shipment.totalCostCents != null) {
    update.shipping_cost_cents = shipment.totalCostCents;
  }
  if (trackingChanged) update.shipping_email_sent_at = null;

  const supabase = getOrgScopedClient(orgId);
  const { error } = await supabase
    .from("shop_orders")
    .update(update)
    .eq("id", order.id)
    .eq("status", "paid");
  if (error) throw error;

  // Best-effort patient notification — never fails the request.
  try {
    await sendShippingNotificationIfNew({ orgId, orderId: order.id, log });
  } catch (err) {
    log?.warn?.(
      {
        orderId: order.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "xps-shipping: shipping notification failed (non-fatal)",
    );
  }

  return {
    kind: "booked",
    carrier,
    trackingNumber: shipment.trackingNumber,
    bookNumber: shipment.bookNumber,
  };
}

// ---------------------------------------------------------------------
// GET /admin/shipping/xps/status — adapter availability
// ---------------------------------------------------------------------
router.get(
  "/admin/shipping/xps/status",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const adapter = await getAdapterForOrg(orgId);
    res.json({ availability: adapter.availability() });
  },
);

// ---------------------------------------------------------------------
// GET /admin/shipping/xps/queue — orders awaiting a shipping label
// ---------------------------------------------------------------------
// Paid, ship-method orders not yet shipped (no tracking). The DME's
// "print labels" worklist.
router.get(
  "/admin/shipping/xps/queue",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
      100,
    );
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("shop_orders")
      .select(
        "id, status, customer_email, shipping_address_json, xps_label_status, created_at, amount_total_cents",
      )
      .eq("status", "paid")
      .eq("fulfillment_method", "ship")
      .is("shipped_at", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    type QueueRow = {
      id: string;
      status: string;
      customer_email: string | null;
      shipping_address_json: unknown;
      xps_label_status: "staged" | "booked" | "voided" | null;
      created_at: string;
      amount_total_cents: number | null;
    };
    const orders = ((data ?? []) as QueueRow[]).map((row) => {
      const addr =
        (row.shipping_address_json as SavedShippingAddress | null) ?? null;
      return {
        id: row.id,
        createdAt: row.created_at,
        amountTotalCents: row.amount_total_cents,
        labelStatus: row.xps_label_status,
        // City/state only in the list view — full address only when a
        // label is actually created. Keeps the worklist low-PHI.
        shipTo: addr ? `${addr.city}, ${addr.state} ${addr.postalCode}` : null,
        hasAddress: Boolean(addr?.line1),
      };
    });
    res.json({ orders });
  },
);

// ---------------------------------------------------------------------
// POST /admin/shop/orders/:orderId/shipping/rates — rate-shop carriers
// ---------------------------------------------------------------------
router.post(
  "/admin/shop/orders/:orderId/shipping/rates",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = ratesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    const receiver = await buildReceiver(orgId, order);
    if ("error" in receiver) {
      res.status(409).json({ error: receiver.error });
      return;
    }
    const adapter = await getAdapterForOrg(orgId);
    const result = await adapter.quoteRates({
      receiver,
      parcels: [parsed.data.parcel],
      residential: parsed.data.residential,
      carrierCode: parsed.data.carrierCode ?? null,
    });
    if (!result.ok) {
      res
        .status(adapterErrorStatus(result.error))
        .json({ error: "xps_error", reason: result.error });
      return;
    }
    res.json({ rates: result.value });
  },
);

// ---------------------------------------------------------------------
// POST /admin/shop/orders/:orderId/shipping/label — create + book label
// ---------------------------------------------------------------------
router.post(
  "/admin/shop/orders/:orderId/shipping/label",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = labelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (order.status !== "paid") {
      res
        .status(409)
        .json({ error: "order_not_paid", currentStatus: order.status });
      return;
    }
    if (order.fulfillmentMethod === "pickup") {
      res.status(409).json({ error: "order_is_pickup" });
      return;
    }

    // Same paperwork gate the manual /tracking flow enforces: required
    // intake paperwork must be signed before a patient-linked order ships.
    const gate = await evaluatePaperworkGateForCustomer(order.customerId);
    if (gate.required && !gate.satisfied) {
      res.status(409).json({
        error: "order_requires_signed_paperwork",
        missingForms: gate.missingForms,
      });
      return;
    }

    const receiver = await buildReceiver(orgId, order);
    if ("error" in receiver) {
      res.status(409).json({ error: receiver.error });
      return;
    }

    const adapter = await getAdapterForOrg(orgId);
    const created = await adapter.createOrder({
      orderId,
      orderNumber: orderId.slice(0, 8),
      receiver,
      parcels: [parsed.data.parcel],
      shippingService: parsed.data.shippingService,
      contentDescription: parsed.data.contentDescription ?? "CPAP supplies",
      reference1: orderId.slice(0, 8),
    });
    if (!created.ok) {
      res
        .status(adapterErrorStatus(created.error))
        .json({ error: "xps_error", reason: created.error });
      return;
    }

    // Mark staged immediately so a failed resolve still leaves a record
    // the sync endpoint / job can pick up.
    const supabase = getOrgScopedClient(orgId);
    await supabase
      .from("shop_orders")
      .update({
        xps_label_status: "staged",
        shipping_service_code: parsed.data.shippingService,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    req.log?.info?.(
      {
        orderId,
        adminEmail: req.adminEmail,
        service: parsed.data.shippingService,
      },
      "xps-shipping: order staged in XPS",
    );

    // Try to resolve into a booked shipment right away (XPS auto-process
    // rules usually book within a second or two). A couple of short
    // retries cover the common case; otherwise the UI polls /sync.
    let resolved = await resolveAndPersist({
      orgId,
      order,
      adapter,
      log: req.log,
    });
    for (
      let attempt = 0;
      attempt < 2 && resolved.kind === "staged";
      attempt++
    ) {
      await new Promise((r) => setTimeout(r, 1200));
      resolved = await resolveAndPersist({
        orgId,
        order,
        adapter,
        log: req.log,
      });
    }

    if (resolved.kind === "error") {
      // The order is staged in XPS; surface a soft status so the UI can
      // offer "sync" rather than treating it as a hard failure.
      res.status(202).json({ status: "staged", note: "awaiting_processing" });
      return;
    }
    if (resolved.kind === "staged") {
      res.status(202).json({ status: "staged" });
      return;
    }
    res.json({
      status: "booked",
      carrier: resolved.carrier,
      trackingNumber: resolved.trackingNumber,
      bookNumber: resolved.bookNumber,
    });
  },
);

// ---------------------------------------------------------------------
// POST /admin/shop/orders/:orderId/shipping/sync — resolve staged order
// ---------------------------------------------------------------------
router.post(
  "/admin/shop/orders/:orderId/shipping/sync",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    const adapter = await getAdapterForOrg(orgId);
    const resolved = await resolveAndPersist({
      orgId,
      order,
      adapter,
      log: req.log,
    });
    if (resolved.kind === "error") {
      res
        .status(resolved.status)
        .json({ error: "xps_error", reason: resolved.error });
      return;
    }
    if (resolved.kind === "staged") {
      res.json({ status: "staged" });
      return;
    }
    res.json({
      status: "booked",
      carrier: resolved.carrier,
      trackingNumber: resolved.trackingNumber,
      bookNumber: resolved.bookNumber,
    });
  },
);

// ---------------------------------------------------------------------
// GET /admin/shop/orders/:orderId/shipping/label.pdf — stream label
// ---------------------------------------------------------------------
router.get(
  "/admin/shop/orders/:orderId/shipping/label.pdf",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (!order.xpsBookNumber) {
      res.status(409).json({ error: "label_not_booked" });
      return;
    }
    const adapter = await getAdapterForOrg(orgId);
    const label = await adapter.getLabel(order.xpsBookNumber, "PDF");
    if (!label.ok) {
      res
        .status(adapterErrorStatus(label.error))
        .json({ error: "xps_error", reason: label.error });
      return;
    }
    res.setHeader("Content-Type", label.value.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="label-${orderId.slice(0, 8)}.pdf"`,
    );
    // Labels carry PHI — never let an intermediary cache them.
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(label.value.bytes));
  },
);

// ---------------------------------------------------------------------
// POST /admin/shop/orders/:orderId/shipping/void — cancel a label
// ---------------------------------------------------------------------
router.post(
  "/admin/shop/orders/:orderId/shipping/void",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (!order.xpsLabelStatus || order.xpsLabelStatus === "voided") {
      res.status(409).json({ error: "no_label_to_void" });
      return;
    }
    const adapter = await getAdapterForOrg(orgId);
    const voided = await adapter.deleteOrder(orderId);
    if (!voided.ok) {
      res
        .status(adapterErrorStatus(voided.error))
        .json({ error: "xps_error", reason: voided.error });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    await supabase
      .from("shop_orders")
      .update({
        xps_label_status: "voided",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);
    req.log?.info?.(
      { orderId, adminEmail: req.adminEmail },
      "xps-shipping: label voided",
    );
    res.json({ status: "voided" });
  },
);

export default router;
