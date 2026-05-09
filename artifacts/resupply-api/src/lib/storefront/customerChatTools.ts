/**
 * Tool descriptors and dispatcher for the SIGNED-IN customer chatbot
 * (POST /shop/me/chat).
 *
 * Distinct from chatbotTools.ts:
 *   - Public PennBot tools work over the static mask catalog; they are
 *     synchronous and reveal nothing customer-specific.
 *   - These tools read PER-CALLER data from the database, scoped by
 *     the requireSignedIn middleware's `req.userCustomerId`. They are
 *     async and require the customerId to be passed in by the route.
 *
 * Tools implemented:
 *   - get_my_recent_orders(limit?)  → last N paid orders + tracking
 *   - get_order_details(orderId)    → line items for one order
 *   - get_my_subscriptions()        → active resupply subscriptions
 *   - get_my_device()               → saved CPAP machine on file
 *
 * Privacy posture:
 *   - Every read filters on customer_id = the authenticated caller.
 *     Even if the model passes a forged orderId from another patient,
 *     get_order_details returns "not_found" because the WHERE clause
 *     never matches.
 *   - Tool results never include other patients' data.
 *   - Street/zip are NOT returned by get_my_recent_orders — only
 *     city + state. Tracking numbers ARE returned (the patient
 *     already sees them on their /shop/orders page).
 */

import { z } from "zod";

import type {
  CpapDeviceInfo,
  ResupplySupabaseClient,
  SavedShippingAddress,
} from "@workspace/resupply-db";

/** Maximum tool-execution rounds per user turn — defense vs runaway. */
export const MAX_CUSTOMER_TOOL_ROUNDS = 2;

/** OpenAI tool descriptor shape (subset we actually need). */
export interface OpenAiToolDescriptor {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: false;
    };
  };
}

const recentOrdersArgsSchema = z
  .object({
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const orderDetailsArgsSchema = z
  .object({
    orderId: z.string().min(1).max(64),
  })
  .strict();

const noArgsSchema = z.object({}).strict();

export const CUSTOMER_CHAT_TOOLS: OpenAiToolDescriptor[] = [
  {
    type: "function",
    function: {
      name: "get_my_recent_orders",
      description:
        "Look up the signed-in customer's most recent paid orders. Returns each order's id, total, status, ship-to city/state, tracking carrier+number+URL, and item count. Use for 'where is my order', 'did my last shipment go out', 'what's my tracking number'.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description:
              "How many orders to return (default 5, max 10). Most-recent first.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_details",
      description:
        "Look up the full line items for one of the signed-in customer's orders. Pass the orderId returned by get_my_recent_orders. Returns line items (productId, quantity, unit price) and ship-to city/state. If the orderId does not belong to this customer, returns not_found.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          orderId: {
            type: "string",
            description:
              "The internal order id returned by get_my_recent_orders. UUID.",
          },
        },
        required: ["orderId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_subscriptions",
      description:
        "List the signed-in customer's resupply / Subscribe-and-Save subscriptions. Returns each subscription's status, items (name + quantity), next billing date, cadence label, and whether it's set to cancel at period end. Use for 'show me my subscriptions', 'when does my next ship go out', 'is my resupply paused'.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_device",
      description:
        "Look up the signed-in customer's saved CPAP machine. Returns manufacturer + model + pressure setting + humidifier setting if they've filled the form out, otherwise returns not_set. Use when the user asks 'what machine do I have', 'what pressure am I on', 'do you have my device on file'.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
];

interface RecentOrderEntry {
  orderId: string;
  sessionId: string;
  status: string;
  amountTotalCents: number | null;
  currency: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shipCity: string | null;
  shipState: string | null;
  itemCount: number;
}

interface OrderDetailsLineItem {
  productId: string;
  quantity: number;
  unitAmountCents: number | null;
  currency: string | null;
}

interface OrderDetailsEntry {
  orderId: string;
  sessionId: string;
  status: string;
  amountTotalCents: number | null;
  currency: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shipCity: string | null;
  shipState: string | null;
  items: OrderDetailsLineItem[];
}

interface SubscriptionItemEntry {
  name: string | null;
  quantity: number;
  unitAmountCents: number | null;
  currency: string | null;
  intervalLabel: string | null;
}

interface SubscriptionEntry {
  subscriptionId: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  items: SubscriptionItemEntry[];
}

interface DeviceEntry {
  manufacturer: string;
  model: string;
  pressureSetting: string | null;
  humidifierSetting: string | null;
}

/**
 * Discriminated tool result. `ok: true` carries a JSON-serializable
 * payload we forward back to the model verbatim; `ok: false` carries
 * a short human-readable error the model can surface to the user.
 */
export type CustomerChatToolResult =
  | { ok: true; data: { orders: RecentOrderEntry[] } }
  | { ok: true; data: OrderDetailsEntry }
  | { ok: true; data: { subscriptions: SubscriptionEntry[] } }
  | { ok: true; data: DeviceEntry }
  | { ok: true; data: { found: false; kind: "device" | "order" } }
  | { ok: false; error: string };

/**
 * Carrier → tracking-URL template. Mirrors the (smaller) table in
 * routes/shop/my-orders.ts so the chat tool exposes the same link
 * shape the customer already sees on their orders page. Lower-cased
 * keys; unknown carriers return null.
 */
const TRACKING_URL_TEMPLATES: Record<string, string> = {
  ups: "https://www.ups.com/track?tracknum={n}",
  usps: "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1={n}",
  fedex: "https://www.fedex.com/fedextrack/?trknbr={n}",
  dhl: "https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id={n}",
  ontrac: "https://www.ontrac.com/trackingres.asp?tracking_number={n}",
};

function computeTrackingUrl(
  carrier: string | null,
  number: string | null,
): string | null {
  if (!carrier || !number) return null;
  const tpl = TRACKING_URL_TEMPLATES[carrier.toLowerCase().trim()];
  if (!tpl) return null;
  return tpl.replace("{n}", encodeURIComponent(number));
}

const RECENT_ORDERS_DEFAULT_LIMIT = 5;

/**
 * Parameters every customer chat tool receives. The route owns the DB
 * client and the auth-resolved customerId; tools never read those from
 * a global so unit tests can pass an in-memory client + spoofed id.
 */
export interface CustomerChatToolContext {
  supabase: ResupplySupabaseClient;
  customerId: string;
}

interface SubscriptionItemPayload {
  name?: string | null;
  quantity?: number | null;
  unitAmountCents?: number | null;
  currency?: string | null;
  intervalLabel?: string | null;
}

async function executeGetRecentOrders(
  ctx: CustomerChatToolContext,
  rawArgs: unknown,
): Promise<CustomerChatToolResult> {
  const parsed = recentOrdersArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `get_my_recent_orders: invalid arguments — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const limit = parsed.data.limit ?? RECENT_ORDERS_DEFAULT_LIMIT;

  const { data: orderRows, error } = await ctx.supabase
    .schema("resupply")
    .from("shop_orders")
    .select(
      "id, stripe_session_id, status, amount_total_cents, currency, paid_at, shipped_at, delivered_at, shipping_address_json, tracking_carrier, tracking_number",
    )
    .eq("customer_id", ctx.customerId)
    .eq("status", "paid")
    .order("paid_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = orderRows ?? [];
  if (rows.length === 0) {
    return { ok: true, data: { orders: [] } };
  }

  const orderIds = rows.map((o) => o.id);
  const { data: itemRows, error: itemErr } = await ctx.supabase
    .schema("resupply")
    .from("shop_order_items")
    .select("order_id, quantity")
    .in("order_id", orderIds);
  if (itemErr) throw itemErr;

  const itemCountByOrder = new Map<string, number>();
  for (const row of itemRows ?? []) {
    itemCountByOrder.set(
      row.order_id,
      (itemCountByOrder.get(row.order_id) ?? 0) + row.quantity,
    );
  }

  const orders: RecentOrderEntry[] = rows.map((o) => {
    const shipAddr = (o.shipping_address_json ??
      null) as SavedShippingAddress | null;
    return {
      orderId: o.id,
      sessionId: o.stripe_session_id,
      status: o.status,
      amountTotalCents: o.amount_total_cents,
      currency: o.currency,
      paidAt: o.paid_at,
      shippedAt: o.shipped_at,
      deliveredAt: o.delivered_at,
      trackingCarrier: o.tracking_carrier,
      trackingNumber: o.tracking_number,
      trackingUrl: computeTrackingUrl(o.tracking_carrier, o.tracking_number),
      shipCity: shipAddr?.city ?? null,
      shipState: shipAddr?.state ?? null,
      itemCount: itemCountByOrder.get(o.id) ?? 0,
    };
  });

  return { ok: true, data: { orders } };
}

async function executeGetOrderDetails(
  ctx: CustomerChatToolContext,
  rawArgs: unknown,
): Promise<CustomerChatToolResult> {
  const parsed = orderDetailsArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `get_order_details: invalid arguments — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  const { data: order, error } = await ctx.supabase
    .schema("resupply")
    .from("shop_orders")
    .select(
      "id, stripe_session_id, status, amount_total_cents, currency, paid_at, shipped_at, delivered_at, shipping_address_json, tracking_carrier, tracking_number",
    )
    .eq("id", parsed.data.orderId)
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (error) throw error;

  if (!order) {
    return { ok: true, data: { found: false, kind: "order" } };
  }

  const { data: itemRows, error: itemErr } = await ctx.supabase
    .schema("resupply")
    .from("shop_order_items")
    .select("product_id, quantity, unit_amount_cents, currency")
    .eq("order_id", order.id);
  if (itemErr) throw itemErr;

  const shipAddr = (order.shipping_address_json ??
    null) as SavedShippingAddress | null;

  const details: OrderDetailsEntry = {
    orderId: order.id,
    sessionId: order.stripe_session_id,
    status: order.status,
    amountTotalCents: order.amount_total_cents,
    currency: order.currency,
    paidAt: order.paid_at,
    shippedAt: order.shipped_at,
    deliveredAt: order.delivered_at,
    trackingCarrier: order.tracking_carrier,
    trackingNumber: order.tracking_number,
    trackingUrl: computeTrackingUrl(
      order.tracking_carrier,
      order.tracking_number,
    ),
    shipCity: shipAddr?.city ?? null,
    shipState: shipAddr?.state ?? null,
    items: (itemRows ?? []).map((r) => ({
      productId: r.product_id,
      quantity: r.quantity,
      unitAmountCents: r.unit_amount_cents,
      currency: r.currency,
    })),
  };

  return { ok: true, data: details };
}

async function executeGetSubscriptions(
  ctx: CustomerChatToolContext,
  rawArgs: unknown,
): Promise<CustomerChatToolResult> {
  const parsed = noArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "get_my_subscriptions: this tool takes no arguments.",
    };
  }

  const { data: rows, error } = await ctx.supabase
    .schema("resupply")
    .from("shop_subscriptions")
    .select(
      "id, status, items, current_period_end, cancel_at_period_end, canceled_at, created_at",
    )
    .eq("customer_id", ctx.customerId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const subscriptions: SubscriptionEntry[] = (rows ?? []).map((r) => {
    const items = (Array.isArray(r.items) ? r.items : []) as
      | SubscriptionItemPayload[]
      | [];
    return {
      subscriptionId: r.id,
      status: r.status,
      currentPeriodEnd: r.current_period_end,
      cancelAtPeriodEnd: r.cancel_at_period_end,
      canceledAt: r.canceled_at,
      items: items.map((it) => ({
        name: it.name ?? null,
        quantity: typeof it.quantity === "number" ? it.quantity : 0,
        unitAmountCents:
          typeof it.unitAmountCents === "number" ? it.unitAmountCents : null,
        currency: it.currency ?? null,
        intervalLabel: it.intervalLabel ?? null,
      })),
    };
  });

  return { ok: true, data: { subscriptions } };
}

async function executeGetDevice(
  ctx: CustomerChatToolContext,
  rawArgs: unknown,
): Promise<CustomerChatToolResult> {
  const parsed = noArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "get_my_device: this tool takes no arguments.",
    };
  }

  const { data: row, error } = await ctx.supabase
    .schema("resupply")
    .from("shop_customers")
    .select("cpap_device_json")
    .eq("customer_id", ctx.customerId)
    .maybeSingle();
  if (error) throw error;

  const device = (row?.cpap_device_json ?? null) as CpapDeviceInfo | null;
  if (!device) {
    return { ok: true, data: { found: false, kind: "device" } };
  }
  return {
    ok: true,
    data: {
      manufacturer: device.manufacturer,
      model: device.model,
      pressureSetting: device.pressureSetting ?? null,
      humidifierSetting: device.humidifierSetting ?? null,
    },
  };
}

/**
 * Execute one tool call from the model. Always returns — never throws —
 * so the chat route's try/catch only has to deal with HTTP failures,
 * not tool errors.
 */
export async function executeCustomerChatTool(
  name: string,
  rawArgs: unknown,
  ctx: CustomerChatToolContext,
): Promise<CustomerChatToolResult> {
  switch (name) {
    case "get_my_recent_orders":
      return executeGetRecentOrders(ctx, rawArgs);
    case "get_order_details":
      return executeGetOrderDetails(ctx, rawArgs);
    case "get_my_subscriptions":
      return executeGetSubscriptions(ctx, rawArgs);
    case "get_my_device":
      return executeGetDevice(ctx, rawArgs);
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

/**
 * Serialize a tool result for inclusion in the OpenAI tool message.
 * Must be a string; we use compact JSON.
 */
export function serializeCustomerToolResult(
  result: CustomerChatToolResult,
): string {
  if (result.ok) return JSON.stringify(result.data);
  return JSON.stringify({ error: result.error });
}
