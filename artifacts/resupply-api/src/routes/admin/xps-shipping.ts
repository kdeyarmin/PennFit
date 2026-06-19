// /admin/shipping/xps/* and /admin/shop/orders/:orderId/shipping/* —
// XPS Ship shipping-label integration.
//
// What this gives DME staff: instead of re-keying every patient's name
// and address into XPS's Webship UI, PennFit merges the order's shipping
// address straight onto the label. The flow mirrors XPS's stage-then-
// process REST model:
//
//   1. rates  — rate-shop carriers for the parcel (informational).
//   2. label  — Put Order into XPS with the merged patient/address data
//               and the chosen service, then resolve the booked shipment
//               (bookNumber + tracking) and store it. On success the order
//               is stamped shipped and the existing patient shipping
//               notification (email/SMS/push) fires.
//   3. sync   — re-resolve an order XPS staged but hadn't booked yet.
//   4. label.pdf — stream the printable label bytes for printing.
//   5. void   — cancel a staged order / label.
//   6. batch-label — stage + resolve labels for MANY orders at once
//               (parcel auto-computed from per-product presets).
//   7. product-specs — manage the per-product parcel weight presets.
//
// Shared order-load / receiver / parcel / resolve logic lives in
// lib/shipping/xps-core.ts so the background auto-resolve worker job uses
// the same implementation.
//
// PHI posture: the label carries the patient's name + address (that's its
// purpose). We never log the address, the label bytes, or XPS response
// bodies — only structural counts + order ids + carrier codes.
//
// Per-tenant: each DME brings its own XPS account, so the adapter is built
// from getEffectiveEnvForOrg(orgId) at call time.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getOrgScopedClient,
  type SavedShippingAddress,
} from "@workspace/resupply-db";
import { validateReceiverAddress } from "@workspace/resupply-integrations-xps-ship";

import { requirePermission } from "../../middlewares/requireAdmin";
import { getEffectiveEnvForOrg } from "../../lib/app-config/store";
import { evaluatePaperworkGateForCustomer } from "../../lib/paperwork/require-signed-paperwork";
import {
  adapterErrorStatus,
  buildAndValidateReceiver,
  computeParcelForOrder,
  defaultParcelWeightOz,
  getXpsAdapterForOrg,
  loadShippingOrder,
  resolveAndPersist,
  type ShippingOrderRow,
} from "../../lib/shipping/xps-core";

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

const batchBodySchema = z.object({
  orderIds: z.array(z.string()).min(1).max(50),
  shippingService: z.string().trim().min(1).max(60),
  residential: z.boolean().optional(),
});

const productSpecSchema = z.object({
  productId: z.string().trim().min(1).max(255),
  weightOz: z
    .number()
    .positive()
    .max(70 * 16),
  lengthIn: z.number().positive().max(108).nullish(),
  widthIn: z.number().positive().max(108).nullish(),
  heightIn: z.number().positive().max(108).nullish(),
  label: z.string().trim().max(120).nullish(),
});
const productSpecsBodySchema = z.object({
  specs: z.array(productSpecSchema).min(1).max(200),
});

function tenant(
  req: { orgId?: string },
  res: { status: (n: number) => { json: (b: unknown) => void } },
): string | null {
  if (!req.orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return null;
  }
  return req.orgId;
}

/** Structural address-validity for the queue list (name not required here). */
function addressLooksValid(addr: SavedShippingAddress | null): boolean {
  if (!addr) return false;
  return validateReceiverAddress({
    name: "placeholder",
    address1: addr.line1,
    city: addr.city,
    state: addr.state,
    zip: addr.postalCode,
    country: addr.country || "US",
  }).ok;
}

// ---------------------------------------------------------------------
// GET /admin/shipping/xps/status — adapter availability
// ---------------------------------------------------------------------
router.get(
  "/admin/shipping/xps/status",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orgId = tenant(req, res);
    if (!orgId) return;
    const adapter = await getXpsAdapterForOrg(orgId);
    res.json({ availability: adapter.availability() });
  },
);

// ---------------------------------------------------------------------
// GET /admin/shipping/xps/queue — orders awaiting a shipping label
// ---------------------------------------------------------------------
router.get(
  "/admin/shipping/xps/queue",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orgId = tenant(req, res);
    if (!orgId) return;
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
        shipTo: addr ? `${addr.city}, ${addr.state} ${addr.postalCode}` : null,
        hasAddress: Boolean(addr?.line1),
        addressValid: addressLooksValid(addr),
      };
    });
    res.json({ orders });
  },
);

// ---------------------------------------------------------------------
// GET /admin/shop/orders/:orderId/shipping/suggested-parcel
// ---------------------------------------------------------------------
// Pre-fills the create-label form from per-product weight presets.
router.get(
  "/admin/shop/orders/:orderId/shipping/suggested-parcel",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orgId = tenant(req, res);
    if (!orgId) return;
    const env = await getEffectiveEnvForOrg(orgId);
    const computed = await computeParcelForOrder(
      orgId,
      orderId,
      defaultParcelWeightOz(env),
    );
    res.json({
      weightOz: computed.parcel.weightOz,
      lengthIn: computed.parcel.lengthIn ?? null,
      widthIn: computed.parcel.widthIn ?? null,
      heightIn: computed.parcel.heightIn ?? null,
      fromPresets: computed.fromPresets,
      missingProductIds: computed.missingProductIds,
    });
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
    const orgId = tenant(req, res);
    if (!orgId) return;
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
    const built = await buildAndValidateReceiver(orgId, order);
    if ("error" in built) {
      res.status(409).json({ error: built.error });
      return;
    }
    const adapter = await getXpsAdapterForOrg(orgId);
    const result = await adapter.quoteRates({
      receiver: built.receiver,
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

/**
 * Shared create-label core: validate preconditions, build + validate the
 * receiver, Put Order, mark staged, then resolve. Returns a discriminated
 * outcome the route handlers translate to HTTP. Used by both the single
 * /label endpoint and the batch endpoint.
 */
async function createAndResolveLabel(args: {
  orgId: string;
  order: ShippingOrderRow;
  parcel: {
    weightOz: number;
    lengthIn?: number | null;
    widthIn?: number | null;
    heightIn?: number | null;
  };
  shippingService: string;
  contentDescription?: string | null;
  pollResolve: boolean;
  log:
    | { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
    | undefined;
}): Promise<
  | {
      ok: true;
      status: "booked";
      carrier: string;
      trackingNumber: string;
      bookNumber: string;
    }
  | { ok: true; status: "staged" }
  | { ok: false; status: number; error: string; issues?: unknown }
> {
  const {
    orgId,
    order,
    parcel,
    shippingService,
    contentDescription,
    pollResolve,
    log,
  } = args;

  if (order.status !== "paid") {
    return { ok: false, status: 409, error: "order_not_paid" };
  }
  if (order.fulfillmentMethod === "pickup") {
    return { ok: false, status: 409, error: "order_is_pickup" };
  }
  const gate = await evaluatePaperworkGateForCustomer(order.customerId);
  if (gate.required && !gate.satisfied) {
    return {
      ok: false,
      status: 409,
      error: "order_requires_signed_paperwork",
      issues: gate.missingForms,
    };
  }
  const built = await buildAndValidateReceiver(orgId, order);
  if ("error" in built) {
    return { ok: false, status: 409, error: built.error };
  }
  if (built.issues.length > 0) {
    return {
      ok: false,
      status: 422,
      error: "invalid_address",
      issues: built.issues,
    };
  }

  const adapter = await getXpsAdapterForOrg(orgId);
  const created = await adapter.createOrder({
    orderId: order.id,
    orderNumber: order.id.slice(0, 8),
    receiver: built.receiver,
    parcels: [parcel],
    shippingService,
    contentDescription: contentDescription ?? "CPAP supplies",
    reference1: order.id.slice(0, 8),
  });
  if (!created.ok) {
    return {
      ok: false,
      status: adapterErrorStatus(created.error),
      error: created.error,
    };
  }

  const supabase = getOrgScopedClient(orgId);
  const { error: stageErr } = await supabase
    .from("shop_orders")
    .update({
      xps_label_status: "staged",
      shipping_service_code: shippingService,
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);
  // The order is already staged in XPS at this point; a failed local write
  // must not be swallowed (we'd report success on an inconsistent row).
  if (stageErr) throw stageErr;

  let resolved = await resolveAndPersist({ orgId, order, adapter, log });
  const maxExtra = pollResolve ? 2 : 0;
  for (let i = 0; i < maxExtra && resolved.kind === "staged"; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    resolved = await resolveAndPersist({ orgId, order, adapter, log });
  }

  if (resolved.kind === "booked") {
    return {
      ok: true,
      status: "booked",
      carrier: resolved.carrier,
      trackingNumber: resolved.trackingNumber,
      bookNumber: resolved.bookNumber,
    };
  }
  // Both "staged" and a resolve-time adapter error leave the order staged
  // in XPS; the sync endpoint / worker job will pick it up.
  return { ok: true, status: "staged" };
}

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
    const orgId = tenant(req, res);
    if (!orgId) return;
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
    const outcome = await createAndResolveLabel({
      orgId,
      order,
      parcel: parsed.data.parcel,
      shippingService: parsed.data.shippingService,
      contentDescription: parsed.data.contentDescription,
      pollResolve: true,
      log: req.log,
    });
    if (!outcome.ok) {
      res
        .status(outcome.status)
        .json({ error: outcome.error, issues: outcome.issues });
      return;
    }
    req.log?.info?.(
      {
        orderId,
        adminEmail: req.adminEmail,
        service: parsed.data.shippingService,
        result: outcome.status,
      },
      "xps-shipping: label created",
    );
    if (outcome.status === "booked") {
      res.json({
        status: "booked",
        carrier: outcome.carrier,
        trackingNumber: outcome.trackingNumber,
        bookNumber: outcome.bookNumber,
      });
    } else {
      res.status(202).json({ status: "staged" });
    }
  },
);

// ---------------------------------------------------------------------
// POST /admin/shipping/xps/batch-label — create labels for many orders
// ---------------------------------------------------------------------
router.post(
  "/admin/shipping/xps/batch-label",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orgId = tenant(req, res);
    if (!orgId) return;
    const parsed = batchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const env = await getEffectiveEnvForOrg(orgId);
    const defaultWeight = defaultParcelWeightOz(env);

    const results: Array<{
      orderId: string;
      status: "booked" | "staged" | "error";
      trackingNumber?: string;
      carrier?: string;
      error?: string;
    }> = [];

    // Sequential to keep XPS request pressure bounded and isolate failures.
    for (const rawId of parsed.data.orderIds) {
      const orderId = validateOrderId(rawId);
      if (!orderId) {
        results.push({
          orderId: rawId,
          status: "error",
          error: "invalid_order_id",
        });
        continue;
      }
      try {
        const order = await loadShippingOrder(orgId, orderId);
        if (!order) {
          results.push({ orderId, status: "error", error: "order_not_found" });
          continue;
        }
        const computed = await computeParcelForOrder(
          orgId,
          orderId,
          defaultWeight,
        );
        const outcome = await createAndResolveLabel({
          orgId,
          order,
          parcel: computed.parcel,
          shippingService: parsed.data.shippingService,
          pollResolve: false,
          log: req.log,
        });
        if (!outcome.ok) {
          results.push({ orderId, status: "error", error: outcome.error });
        } else if (outcome.status === "booked") {
          results.push({
            orderId,
            status: "booked",
            trackingNumber: outcome.trackingNumber,
            carrier: outcome.carrier,
          });
        } else {
          results.push({ orderId, status: "staged" });
        }
      } catch (err) {
        // Log the Error object itself so the logger's err.* redaction
        // applies (a pre-stringified message would bypass it).
        req.log?.warn?.(
          { orderId, err },
          "xps-shipping: batch label error (isolated)",
        );
        results.push({ orderId, status: "error", error: "unexpected_error" });
      }
    }

    const booked = results.filter((r) => r.status === "booked").length;
    const staged = results.filter((r) => r.status === "staged").length;
    const errored = results.filter((r) => r.status === "error").length;
    req.log?.info?.(
      { orgId, adminEmail: req.adminEmail, booked, staged, errored },
      "xps-shipping: batch label complete",
    );
    res.json({ results, summary: { booked, staged, errored } });
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
    const orgId = tenant(req, res);
    if (!orgId) return;
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    const adapter = await getXpsAdapterForOrg(orgId);
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
    const orgId = tenant(req, res);
    if (!orgId) return;
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (!order.xpsBookNumber) {
      res.status(409).json({ error: "label_not_booked" });
      return;
    }
    const adapter = await getXpsAdapterForOrg(orgId);
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
    const orgId = tenant(req, res);
    if (!orgId) return;
    const order = await loadShippingOrder(orgId, orderId);
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (!order.xpsLabelStatus || order.xpsLabelStatus === "voided") {
      res.status(409).json({ error: "no_label_to_void" });
      return;
    }
    const adapter = await getXpsAdapterForOrg(orgId);
    const voided = await adapter.deleteOrder(orderId);
    if (!voided.ok) {
      res
        .status(adapterErrorStatus(voided.error))
        .json({ error: "xps_error", reason: voided.error });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { error: voidErr } = await supabase
      .from("shop_orders")
      .update({
        xps_label_status: "voided",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);
    // Don't report success if the local status write failed.
    if (voidErr) throw voidErr;
    req.log?.info?.(
      { orderId, adminEmail: req.adminEmail },
      "xps-shipping: label voided",
    );
    res.json({ status: "voided" });
  },
);

// ---------------------------------------------------------------------
// GET /admin/shipping/xps/product-specs — list parcel presets
// ---------------------------------------------------------------------
// Returns saved presets plus the distinct product ids seen on orders still
// awaiting shipment (so staff can seed weights for products they actually
// ship). Order items don't persist a title, so unsaved rows show the id.
router.get(
  "/admin/shipping/xps/product-specs",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orgId = tenant(req, res);
    if (!orgId) return;
    const supabase = getOrgScopedClient(orgId);

    const { data: specsData, error: specErr } = await supabase
      .from("product_ship_specs")
      .select("product_id, weight_oz, length_in, width_in, height_in, label")
      .order("updated_at", { ascending: false })
      .limit(500);
    if (specErr) throw specErr;
    const specs = (
      (specsData ?? []) as Array<{
        product_id: string;
        weight_oz: number;
        length_in: number | null;
        width_in: number | null;
        height_in: number | null;
        label: string | null;
      }>
    ).map((s) => ({
      productId: s.product_id,
      weightOz: s.weight_oz,
      lengthIn: s.length_in,
      widthIn: s.width_in,
      heightIn: s.height_in,
      label: s.label,
    }));

    // Distinct product ids on unshipped, paid, ship-method orders.
    const { data: orderRows, error: ordErr } = await supabase
      .from("shop_orders")
      .select("id")
      .eq("status", "paid")
      .eq("fulfillment_method", "ship")
      .is("shipped_at", null)
      .limit(200);
    if (ordErr) throw ordErr;
    const orderIds = ((orderRows ?? []) as Array<{ id: string }>).map(
      (o) => o.id,
    );
    const seen = new Set<string>();
    if (orderIds.length > 0) {
      const { data: itemRows, error: itemErr } = await supabase
        .from("shop_order_items")
        .select("product_id")
        .in("order_id", orderIds)
        .limit(2000);
      if (itemErr) throw itemErr;
      for (const r of (itemRows ?? []) as Array<{ product_id: string }>) {
        seen.add(r.product_id);
      }
    }
    const known = new Set(specs.map((s) => s.productId));
    const unconfiguredProductIds = [...seen].filter((id) => !known.has(id));

    res.json({ specs, unconfiguredProductIds });
  },
);

// ---------------------------------------------------------------------
// PUT /admin/shipping/xps/product-specs — upsert parcel presets
// ---------------------------------------------------------------------
router.put(
  "/admin/shipping/xps/product-specs",
  requirePermission("returns.manage"),
  async (req, res) => {
    const orgId = tenant(req, res);
    if (!orgId) return;
    const parsed = productSpecsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();
    const rows = parsed.data.specs.map((s) => ({
      product_id: s.productId,
      weight_oz: s.weightOz,
      length_in: s.lengthIn ?? null,
      width_in: s.widthIn ?? null,
      height_in: s.heightIn ?? null,
      label: s.label ?? null,
      updated_at: nowIso,
    }));
    const { error } = await supabase
      .from("product_ship_specs")
      .upsert(rows, { onConflict: "org_id,product_id" });
    if (error) throw error;
    req.log?.info?.(
      { orgId, adminEmail: req.adminEmail, count: rows.length },
      "xps-shipping: product specs upserted",
    );
    res.json({ ok: true, count: rows.length });
  },
);

export default router;
