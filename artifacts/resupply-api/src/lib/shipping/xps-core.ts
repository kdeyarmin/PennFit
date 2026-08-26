// Shared XPS Ship logic used by both the interactive admin routes
// (routes/admin/xps-shipping.ts) and the background auto-resolve worker
// job (worker/jobs/xps-resolve-staged.ts).
//
// Keeping order-load / receiver-build / parcel-computation / shipment-
// resolution here (rather than in the route) means the worker can resolve
// staged orders without importing an Express router, and the batch + single
// label paths share one implementation.

import {
  getOrgScopedClient,
  type Database,
  type SavedShippingAddress,
} from "@workspace/resupply-db";
import {
  createXpsShipAdapter,
  validateReceiverAddress,
  type AddressIssue,
  type XpsAddress,
  type XpsParcel,
  type XpsShipAdapter,
} from "@workspace/resupply-integrations-xps-ship";

import { getEffectiveEnvForOrg } from "../app-config/store";
import { resolveSmsRecipientForShopOrder } from "../shop-orders-sms-resolver";
import { sendShippingNotificationIfNew } from "../order-emails/send-shipping-notification-if-new";

type ShopOrderUpdate = Database["resupply"]["Tables"]["shop_orders"]["Update"];

/** Built-in fallback parcel weight when nothing else is known (1 lb). */
const FALLBACK_WEIGHT_OZ = 16;

export interface ShippingOrderRow {
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

export const SHIPPING_COLUMNS =
  "id, status, customer_id, customer_email, fulfillment_method, shipping_address_json, tracking_carrier, tracking_number, xps_book_number, xps_label_status";

export function rowToShippingOrder(row: {
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

export async function loadShippingOrder(
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

export async function getXpsAdapterForOrg(
  orgId: string,
): Promise<XpsShipAdapter> {
  const env = await getEffectiveEnvForOrg(orgId);
  return createXpsShipAdapter(env);
}

/** The configured default parcel weight (oz), or the 1 lb fallback. */
export function defaultParcelWeightOz(env: NodeJS.ProcessEnv): number {
  const raw = env.XPS_SHIP_DEFAULT_WEIGHT_OZ?.trim();
  if (raw && /^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number.parseFloat(raw);
    if (n > 0) return n;
  }
  return FALLBACK_WEIGHT_OZ;
}

export interface ComputedParcel {
  parcel: XpsParcel;
  /** True when every line item had a weight preset (high confidence). */
  fromPresets: boolean;
  /** Product ids on the order that have no ship-spec preset. */
  missingProductIds: string[];
}

/**
 * Compute a suggested parcel for an order by summing each line item's
 * per-product preset (weight × quantity), taking the max of each
 * dimension. Items without a preset contribute a fallback unit weight, and
 * `fromPresets` reports whether every item was covered.
 */
export async function computeParcelForOrder(
  orgId: string,
  orderId: string,
  defaultWeightOz: number,
): Promise<ComputedParcel> {
  const supabase = getOrgScopedClient(orgId);
  const { data: items, error } = await supabase
    .from("shop_order_items")
    .select("product_id, quantity")
    .eq("order_id", orderId);
  if (error) throw error;

  const lines = (items ?? []) as Array<{
    product_id: string;
    quantity: number;
  }>;
  if (lines.length === 0) {
    return {
      parcel: { weightOz: defaultWeightOz },
      fromPresets: false,
      missingProductIds: [],
    };
  }

  const productIds = [...new Set(lines.map((l) => l.product_id))];
  const { data: specsData, error: specErr } = await supabase
    .from("product_ship_specs")
    .select("product_id, weight_oz, length_in, width_in, height_in")
    .in("product_id", productIds);
  if (specErr) throw specErr;

  const specs = new Map(
    (
      (specsData ?? []) as Array<{
        product_id: string;
        weight_oz: number;
        length_in: number | null;
        width_in: number | null;
        height_in: number | null;
      }>
    ).map((s) => [s.product_id, s]),
  );

  let totalWeight = 0;
  let length: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  const missing: string[] = [];
  const maxOrNull = (a: number | null, b: number | null): number | null =>
    a == null ? b : b == null ? a : Math.max(a, b);

  for (const line of lines) {
    const qty = Math.max(1, line.quantity || 1);
    const spec = specs.get(line.product_id);
    if (spec) {
      totalWeight += spec.weight_oz * qty;
      length = maxOrNull(length, spec.length_in);
      width = maxOrNull(width, spec.width_in);
      height = maxOrNull(height, spec.height_in);
    } else {
      totalWeight += defaultWeightOz * qty;
      if (!missing.includes(line.product_id)) missing.push(line.product_id);
    }
  }

  return {
    parcel: {
      weightOz: Math.round(totalWeight * 100) / 100,
      lengthIn: length,
      widthIn: width,
      heightIn: height,
    },
    fromPresets: missing.length === 0,
    missingProductIds: missing,
  };
}

/**
 * Build the XPS receiver from the order's address + customer identity.
 * Returns the address even when incomplete — callers run
 * validateReceiverAddress to surface issues.
 */
export async function buildReceiver(
  orgId: string,
  order: ShippingOrderRow,
): Promise<XpsAddress | { error: "no_shipping_address" }> {
  const addr = order.shippingAddress;
  if (!addr || !addr.line1) {
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
    name = (email?.split("@")[0] ?? "Recipient").slice(0, 60);
  }

  let phone: string | null = null;
  try {
    const recipient = await resolveSmsRecipientForShopOrder({
      customerId: order.customerId,
      customerEmailFromOrder: order.customerEmail,
      orgId,
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

export interface ReceiverWithValidation {
  receiver: XpsAddress;
  issues: AddressIssue[];
}

/** buildReceiver + structural validation in one call. */
export async function buildAndValidateReceiver(
  orgId: string,
  order: ShippingOrderRow,
): Promise<ReceiverWithValidation | { error: "no_shipping_address" }> {
  const receiver = await buildReceiver(orgId, order);
  if ("error" in receiver) return receiver;
  return { receiver, issues: validateReceiverAddress(receiver).issues };
}

export type ResolveResult =
  | {
      kind: "booked";
      carrier: string;
      trackingNumber: string;
      bookNumber: string;
    }
  | { kind: "staged" }
  | { kind: "error"; status: number; error: string };

export function adapterErrorStatus(error: string): number {
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

type Logish =
  | { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
  | undefined;

/**
 * Resolve a staged XPS order into a booked shipment and persist it. On a
 * booked shipment it stamps shipped_at + tracking and fires the existing
 * patient shipping notification. Returns `staged` when XPS hasn't booked
 * the order yet, or `error` on an adapter failure.
 */
export async function resolveAndPersist(args: {
  orgId: string;
  order: ShippingOrderRow;
  adapter: XpsShipAdapter;
  log: Logish;
}): Promise<ResolveResult> {
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

  try {
    await sendShippingNotificationIfNew({ orgId, orderId: order.id, log });
  } catch (err) {
    // Log the Error object itself so the logger's err.* redaction applies.
    log?.warn?.(
      { orderId: order.id, err },
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
