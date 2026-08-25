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
} from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";

import { logger } from "../logger.js";
import {
  IN_APP_MESSAGE_BODY_MAX,
  appendCustomerMessage,
} from "../messaging/in-app-conversation.js";
import { notifyCsrInboxOfCustomerMessage } from "../messaging/csr-inbox-notify.js";
import { DEFAULT_STOREFRONT_ASSISTANT_NAME } from "../company-info.js";

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

/**
 * `escalate_to_human` summary cap — comfortably under the in-app body
 * limit so the prepended PennBot marker still fits, and small enough
 * that a runaway model can't paste a wall of text into the CSR inbox.
 */
const ESCALATION_SUMMARY_MAX = 1_500;

const escalateArgsSchema = z
  .object({
    summary: z.string().trim().min(1).max(ESCALATION_SUMMARY_MAX),
    category: z
      .enum([
        "order_issue",
        "subscription",
        "returns_refund",
        "insurance_billing",
        "prescription",
        "account",
        "complaint",
        "other",
      ])
      .optional(),
  })
  .strict();

export const CUSTOMER_CHAT_TOOLS: OpenAiToolDescriptor[] = [
  {
    type: "function",
    function: {
      name: "get_my_recent_orders",
      description:
        "Look up the signed-in patient's most recent insurance shipments. Returns each one's id, item SKU, quantity, status, and the dates it was queued / shipped / delivered. Use for 'what have you sent me', 'did my cushion go out', 'when was my last resupply'. IMPORTANT: status 'with_warehouse' means it is queued with our warehouse — NOT that it has not shipped; the warehouse marks shipping out of band, so a shipped box can still read this way. There is no tracking number here: if the patient wants tracking or a delivery date, say you cannot see it and offer escalate_to_human. If patientLinked is false, we could not match this account to a patient chart — say you cannot see their shipments from here and offer escalate_to_human. NEVER say they have no orders.",
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
        "Look up one of the signed-in patient's insurance shipments in detail. Pass the orderId returned by get_my_recent_orders. Returns the item SKU, quantity, status and dates, plus substitutedFromSku when a backorder meant a comparable item was sent instead. If the id does not belong to this patient, returns found: false. Same caveats as get_my_recent_orders: no tracking number, and 'with_warehouse' does not mean 'not shipped'.",
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
        "List any standing auto-ship lines on the signed-in customer's account. These come from the retained cash-pay-era tables, so a line may be historical rather than current — describe what it returns without promising it is what will arrive next, and never invite the patient to start, renew or pay for one. For what is actually due next, use get_my_recent_orders or escalate_to_human.",
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
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Forward the customer's request to Penn Home Medical Supply's human customer-service team by posting it to their in-app message thread (the same thread at /account → Messages, which a CSR monitors and replies to). Use this ONLY after the customer has confirmed they want a person — for things you cannot resolve yourself: refund requests, changing or canceling an order/subscription on their behalf, ANY shipping-address change (a patient address change has to be reviewed by a person before the next shipment goes out — you cannot make it yourself), insurance/prescription/prior-auth issues, reporting a wrong or damaged item, complaints, or anything the read-only tools and self-serve pages don't cover. Do NOT use it for questions you already answered or that a self-serve page handles. Compose `summary` as a clear, first-person message FROM the customer's perspective that includes any relevant order id, subscription, dates, or specifics gathered in the conversation, so the CSR has full context without asking again. After it succeeds, tell the customer their message was sent and the team will reply in /account → Messages (or to call (814) 471-0627 if it's urgent).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: {
            type: "string",
            description:
              "The message to send to the support team, written in plain English from the customer's point of view. Include the specific ask and any relevant order id / subscription / dates discussed. Do NOT include SSNs, full card numbers, or insurance member IDs.",
          },
          category: {
            type: "string",
            enum: [
              "order_issue",
              "subscription",
              "returns_refund",
              "insurance_billing",
              "prescription",
              "account",
              "complaint",
              "other",
            ],
            description:
              "Optional best-guess category so the CSR team can triage. Defaults to 'other'.",
          },
        },
      },
    },
  },
];

/**
 * One insurance shipment, as the patient may be told about it.
 *
 * No money fields: supplies are billed to the plan, and a
 * patient-responsibility balance lives on /account/billing rather than
 * on the shipment. No tracking number or carrier either — the
 * fulfillments table has no such columns, because tracking is handled
 * by the warehouse system out of band.
 */
interface RecentOrderEntry {
  orderId: string;
  itemSku: string;
  quantity: number;
  /** queued rows read as "with_warehouse" — see describeFulfillmentStatus. */
  status: string;
  queuedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  /** Set when a backorder made us send a comparable item instead. */
  substitutedFromSku: string | null;
}

type OrderDetailsEntry = RecentOrderEntry;

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
  // `patientLinked: false` is deliberately its own signal rather than an
  // empty list. "We could not bind your account to a patient chart" and
  // "you have no shipments" are different facts, and only one of them is
  // safe to say out loud to a patient waiting on supplies.
  | { ok: true; data: { patientLinked: boolean; orders: RecentOrderEntry[] } }
  | {
      ok: true;
      data: { patientLinked: boolean; found: false };
    }
  | {
      ok: true;
      data: { patientLinked: true; found: true } & OrderDetailsEntry;
    }
  | { ok: true; data: { subscriptions: SubscriptionEntry[] } }
  | { ok: true; data: DeviceEntry }
  | { ok: true; data: { found: false; kind: "device" | "order" } }
  | { ok: true; data: EscalationResult }
  | { ok: false; error: string };

interface EscalationResult {
  /** Discriminator so the model knows this was the escalation tool. */
  escalated: true;
  /** The in-app conversation the message landed in. */
  threadId: string;
  /** True when this message opened a brand-new support thread. */
  threadCreated: boolean;
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
  /**
   * Display name + email of the signed-in caller. Used only by
   * `escalate_to_human` to label the CSR-inbox notification (the same
   * non-PHI label the admin inbox header already shows). Optional so
   * the read-only tools and existing tests don't need to supply them.
   */
  customerDisplayName?: string | null;
  customerEmail?: string | null;
  /**
   * Tenant-resolved storefront assistant name. Used as the persisted
   * "[Via …]" prefix so a non-Penn tenant never stores "PennBot" in
   * the customer-visible thread. Defaults to the in-source placeholder.
   */
  assistantStorefrontName?: string | null;
  /**
   * Per-request branded tool descriptors (Penn Home Medical Supply/PennBot/phone
   * rewritten for this tenant). When omitted, callers send the static
   * CUSTOMER_CHAT_TOOLS placeholders.
   */
  tools?: OpenAiToolDescriptor[];
}

interface SubscriptionItemPayload {
  name?: string | null;
  quantity?: number | null;
  unitAmountCents?: number | null;
  currency?: string | null;
  intervalLabel?: string | null;
}

/**
 * Resolve the signed-in shop customer to the patient whose shipments
 * they are asking about.
 *
 * There is no `shop_customers.patient_id` FK, so the link is the
 * customer's email — the same resolution `/api/me/billing-statements`
 * uses (routes/storefront/me-billing.ts), deliberately kept identical
 * so the chatbot can never see a shipment the billing page would
 * refuse to show.
 *
 * Fetches TWO rows to detect ambiguity. If a household shares an email,
 * or an admin catch-all address landed on several charts, binding to
 * "the first one" would read another patient's shipments to this
 * caller. Anything other than exactly one match returns null and the
 * tool answers "I can't see that from here" rather than guessing.
 */
async function resolvePatientId(
  ctx: CustomerChatToolContext,
): Promise<string | null> {
  const { data: customer, error: customerErr } = await ctx.supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", ctx.customerId)
    .limit(1)
    .maybeSingle();
  if (customerErr) throw customerErr;
  if (!customer?.email_lower) return null;

  // .ilike with escaped meta-characters is case-insensitive equality;
  // legacy patient rows can carry a mixed-case email.
  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients, error: patientErr } = await ctx.supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (patientErr) throw patientErr;
  if (!patients || patients.length !== 1) return null;
  return patients[0]!.id;
}

/**
 * Status as the PATIENT should hear it.
 *
 * This app owns exactly one lifecycle transition — `queued`, written
 * when a resupply is committed against stock. PacWare marks things
 * shipped and delivered out of band via CSV, so `shipped_at` and
 * `delivered_at` are frequently NULL on a row that has genuinely left
 * the building. Reporting the raw column would tell a patient their
 * supplies have not shipped when they may already be in the post.
 *
 * So a queued row is described as "with our warehouse" rather than
 * "not shipped", and the tool tells the model that plainly.
 */
function describeFulfillmentStatus(row: {
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
}): string {
  if (row.delivered_at) return "delivered";
  if (row.shipped_at) return "shipped";
  if (row.status === "cancelled" || row.status === "canceled") {
    return "cancelled";
  }
  return "with_warehouse";
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

  const patientId = await resolvePatientId(ctx);
  if (!patientId) {
    // NOT "you have no orders". We could not bind this caller to a
    // single patient chart, which is a different fact and one the
    // model must not paper over.
    return { ok: true, data: { patientLinked: false, orders: [] } };
  }

  const { data: rows, error } = await ctx.supabase
    .schema("resupply")
    .from("fulfillments")
    .select(
      "id, item_sku, quantity, status, shipped_at, delivered_at, created_at, substituted_from_sku",
    )
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const orders: RecentOrderEntry[] = (rows ?? []).map((r) => ({
    orderId: r.id,
    itemSku: r.item_sku,
    quantity: Number(r.quantity ?? 1),
    status: describeFulfillmentStatus(r),
    queuedAt: r.created_at,
    shippedAt: r.shipped_at,
    deliveredAt: r.delivered_at,
    substitutedFromSku: r.substituted_from_sku ?? null,
  }));

  return { ok: true, data: { patientLinked: true, orders } };
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

  const patientId = await resolvePatientId(ctx);
  if (!patientId) {
    return { ok: true, data: { patientLinked: false, found: false } };
  }

  // patient_id in the WHERE clause is the ownership check: a forged id
  // from another chart simply does not match.
  const { data: row, error } = await ctx.supabase
    .schema("resupply")
    .from("fulfillments")
    .select(
      "id, item_sku, quantity, status, shipped_at, delivered_at, created_at, substituted_from_sku",
    )
    .eq("id", parsed.data.orderId)
    .eq("patient_id", patientId)
    .maybeSingle();
  if (error) throw error;

  if (!row) {
    return { ok: true, data: { patientLinked: true, found: false } };
  }

  const details: OrderDetailsEntry = {
    orderId: row.id,
    itemSku: row.item_sku,
    quantity: Number(row.quantity ?? 1),
    status: describeFulfillmentStatus(row),
    queuedAt: row.created_at,
    shippedAt: row.shipped_at,
    deliveredAt: row.delivered_at,
    substitutedFromSku: row.substituted_from_sku ?? null,
  };

  return { ok: true, data: { patientLinked: true, found: true, ...details } };
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

const ESCALATION_CATEGORY_LABELS: Record<string, string> = {
  order_issue: "Order issue",
  subscription: "Subscription",
  returns_refund: "Return / refund",
  insurance_billing: "Insurance / billing",
  prescription: "Prescription",
  account: "Account",
  complaint: "Complaint",
  other: "General",
};

/**
 * Forward the customer's request to a human CSR. Posts to the caller's
 * in-app conversation thread (lazy-created on first use) via the shared
 * `appendCustomerMessage` helper — the exact same path POST
 * /shop/me/messages uses — so the message shows up in the CSR inbox
 * (status flips to `awaiting_admin`) and in the customer's own
 * /account → Messages view. Writes the same structural audit row and
 * fires the best-effort CSR-inbox notification.
 *
 * The DB write throws on a hard failure (consistent with the read-only
 * tools), which the chat route's try/catch turns into a degraded reply.
 * Audit + notification are best-effort: a failure there must NOT lose
 * the escalation the customer already confirmed.
 */
async function executeEscalateToHuman(
  ctx: CustomerChatToolContext,
  rawArgs: unknown,
): Promise<CustomerChatToolResult> {
  const parsed = escalateArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `escalate_to_human: invalid arguments — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  const categoryLabel =
    ESCALATION_CATEGORY_LABELS[parsed.data.category ?? "other"] ?? "General";
  // Prefix a non-PHI marker so a CSR scanning the inbox can tell this
  // came through the storefront assistant (and was confirmed by the
  // customer) versus a message the customer typed themselves. The body
  // is capped well under IN_APP_MESSAGE_BODY_MAX even after the prefix.
  const assistantName =
    ctx.assistantStorefrontName?.trim() || DEFAULT_STOREFRONT_ASSISTANT_NAME;
  const body =
    `[Via ${assistantName} · ${categoryLabel}]\n` + parsed.data.summary.trim();
  const clampedBody = body.slice(0, IN_APP_MESSAGE_BODY_MAX);

  const result = await appendCustomerMessage({
    supabase: ctx.supabase,
    customerId: ctx.customerId,
    body: clampedBody,
  });

  // Structural-only audit (mirrors POST /shop/me/messages). The audit
  // package is a no-op stub today, but emitting the envelope keeps the
  // surface uniform and gives operators a crumb without exposing the
  // body. Best-effort — never block the escalation on it.
  await logAudit({
    action: "shop_customer.message.send",
    adminEmail: null,
    adminUserId: null,
    targetTable: "messages",
    targetId: result.messageId,
    metadata: {
      conversation_id: result.threadId,
      thread_created: result.threadCreated,
      body_length: clampedBody.length,
      source: "chatbot_escalation",
      category: parsed.data.category ?? "other",
    },
    ip: null,
    userAgent: null,
  }).catch((err) => {
    logger.warn(
      { err, conversation_id: result.threadId },
      "escalate_to_human: audit write failed (message is in the DB regardless)",
    );
  });

  await notifyCsrInboxOfCustomerMessage({
    threadId: result.threadId,
    threadCreated: result.threadCreated,
    customerEmail: ctx.customerEmail ?? null,
    customerDisplayName: ctx.customerDisplayName ?? null,
    source: "chatbot",
    assistantName,
  }).catch((err) => {
    logger.warn(
      { err, conversation_id: result.threadId },
      "escalate_to_human: CSR-inbox notification failed (message is in the DB regardless)",
    );
  });

  return {
    ok: true,
    data: {
      escalated: true,
      threadId: result.threadId,
      threadCreated: result.threadCreated,
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
    case "escalate_to_human":
      return executeEscalateToHuman(ctx, rawArgs);
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
