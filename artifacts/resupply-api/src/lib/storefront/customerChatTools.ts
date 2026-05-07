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
import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  shopCustomers,
  shopOrderItems,
  shopOrders,
  shopSubscriptions,
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
 * handle and the auth-resolved customerId; tools never read those from
 * a global so unit tests can pass an in-memory db + spoofed id.
 */
export interface CustomerChatToolContext {
  db: NodePgDatabase;
  customerId: string;
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

  const orderRows = await ctx.db
    .select({
      id: shopOrders.id,
      stripeSessionId: shopOrders.stripeSessionId,
      status: shopOrders.status,
      amountTotalCents: shopOrders.amountTotalCents,
      currency: shopOrders.currency,
      paidAt: shopOrders.paidAt,
      shippedAt: shopOrders.shippedAt,
      deliveredAt: shopOrders.deliveredAt,
      shippingAddress: shopOrders.shippingAddress,
      trackingCarrier: shopOrders.trackingCarrier,
      trackingNumber: shopOrders.trackingNumber,
    })
    .from(shopOrders)
    .where(
      and(
        eq(shopOrders.customerId, ctx.customerId),
        eq(shopOrders.status, "paid"),
      ),
    )
    .orderBy(desc(shopOrders.paidAt), desc(shopOrders.id))
    .limit(limit);

  if (orderRows.length === 0) {
    return { ok: true, data: { orders: [] } };
  }

  const orderIds = orderRows.map((o) => o.id);
  const itemRows = await ctx.db
    .select({
      orderId: shopOrderItems.orderId,
      quantity: shopOrderItems.quantity,
    })
    .from(shopOrderItems)
    .where(inArray(shopOrderItems.orderId, orderIds));

  const itemCountByOrder = new Map<string, number>();
  for (const row of itemRows) {
    itemCountByOrder.set(
      row.orderId,
      (itemCountByOrder.get(row.orderId) ?? 0) + row.quantity,
    );
  }

  const orders: RecentOrderEntry[] = orderRows.map((o) => ({
    orderId: o.id,
    sessionId: o.stripeSessionId,
    status: o.status,
    amountTotalCents: o.amountTotalCents,
    currency: o.currency,
    paidAt: o.paidAt ? o.paidAt.toISOString() : null,
    shippedAt: o.shippedAt ? o.shippedAt.toISOString() : null,
    deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
    trackingCarrier: o.trackingCarrier,
    trackingNumber: o.trackingNumber,
    trackingUrl: computeTrackingUrl(o.trackingCarrier, o.trackingNumber),
    shipCity: o.shippingAddress?.city ?? null,
    shipState: o.shippingAddress?.state ?? null,
    itemCount: itemCountByOrder.get(o.id) ?? 0,
  }));

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

  const [order] = await ctx.db
    .select({
      id: shopOrders.id,
      stripeSessionId: shopOrders.stripeSessionId,
      status: shopOrders.status,
      amountTotalCents: shopOrders.amountTotalCents,
      currency: shopOrders.currency,
      paidAt: shopOrders.paidAt,
      shippedAt: shopOrders.shippedAt,
      deliveredAt: shopOrders.deliveredAt,
      shippingAddress: shopOrders.shippingAddress,
      trackingCarrier: shopOrders.trackingCarrier,
      trackingNumber: shopOrders.trackingNumber,
    })
    .from(shopOrders)
    .where(
      and(
        eq(shopOrders.id, parsed.data.orderId),
        eq(shopOrders.customerId, ctx.customerId),
      ),
    )
    .limit(1);

  if (!order) {
    return { ok: true, data: { found: false, kind: "order" } };
  }

  const itemRows = await ctx.db
    .select({
      productId: shopOrderItems.productId,
      quantity: shopOrderItems.quantity,
      unitAmountCents: shopOrderItems.unitAmountCents,
      currency: shopOrderItems.currency,
    })
    .from(shopOrderItems)
    .where(eq(shopOrderItems.orderId, order.id));

  const details: OrderDetailsEntry = {
    orderId: order.id,
    sessionId: order.stripeSessionId,
    status: order.status,
    amountTotalCents: order.amountTotalCents,
    currency: order.currency,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
    deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : null,
    trackingCarrier: order.trackingCarrier,
    trackingNumber: order.trackingNumber,
    trackingUrl: computeTrackingUrl(
      order.trackingCarrier,
      order.trackingNumber,
    ),
    shipCity: order.shippingAddress?.city ?? null,
    shipState: order.shippingAddress?.state ?? null,
    items: itemRows.map((r) => ({
      productId: r.productId,
      quantity: r.quantity,
      unitAmountCents: r.unitAmountCents,
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

  const rows = await ctx.db
    .select({
      id: shopSubscriptions.id,
      status: shopSubscriptions.status,
      items: shopSubscriptions.items,
      currentPeriodEnd: shopSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: shopSubscriptions.cancelAtPeriodEnd,
      canceledAt: shopSubscriptions.canceledAt,
      createdAt: shopSubscriptions.createdAt,
    })
    .from(shopSubscriptions)
    .where(eq(shopSubscriptions.customerId, ctx.customerId))
    .orderBy(desc(shopSubscriptions.createdAt));

  const subscriptions: SubscriptionEntry[] = rows.map((r) => ({
    subscriptionId: r.id,
    status: r.status,
    currentPeriodEnd: r.currentPeriodEnd
      ? r.currentPeriodEnd.toISOString()
      : null,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    canceledAt: r.canceledAt ? r.canceledAt.toISOString() : null,
    items: (r.items ?? []).map((it) => ({
      name: it.name,
      quantity: it.quantity,
      unitAmountCents: it.unitAmountCents,
      currency: it.currency,
      intervalLabel: it.intervalLabel,
    })),
  }));

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

  const [row] = await ctx.db
    .select({
      cpapDevice: shopCustomers.cpapDevice,
    })
    .from(shopCustomers)
    .where(eq(shopCustomers.customerId, ctx.customerId))
    .limit(1);

  const device = row?.cpapDevice;
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
