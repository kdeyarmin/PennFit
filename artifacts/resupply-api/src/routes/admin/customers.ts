// /admin/shop/customers/* — admin "Customer 360" surface.
//
// Read-mostly endpoints that surface the cash-pay shop customer
// mirror joined against orders / subscriptions for an at-a-glance
// "who is this person and what have they done with us" view, plus a
// reorder action that generates a Stripe Checkout URL pre-filled
// with a past order's items so the admin can share the link
// out-of-band (email, SMS).
//
// Endpoints (all requireAdmin-gated):
//   GET  /admin/shop/customers
//        Paginated, searchable directory. Driven by
//        shop_customers (registered customers only — guest
//        checkouts have no customer mirror row, so they appear in
//        order detail but not the customer list).
//   GET  /admin/shop/customers/:userId
//        Single-customer profile: full customer record + recent
//        orders + all subscriptions + abandoned cart (if any) +
//        reviews + lifetime stats. Returns 404 only if the userId
//        truly has no presence (no shop_customers row AND no
//        shop_orders rows). Otherwise, a synthesized minimal
//        customer object is returned for guest-checkout-only ids.
//   POST /admin/shop/customers/:userId/reorder
//        Generate a Stripe Checkout Session pre-filled with the
//        line items from a paid past order. Returns the checkout
//        URL for the admin to share with the customer (email/SMS,
//        out-of-band). Does NOT charge the customer or modify any
//        local rows — Stripe state is the only side-effect.
//
// Authorization:
//   requireAdmin (RESUPPLY_ADMIN_EMAILS allowlist). Same gate as
//   every other file in this directory.
//
// PHI / log posture (matches shop-orders.ts / shop-reviews.ts /
// abandoned-carts.ts in this directory):
//   * List view returns redactEmail(...) only — never the full
//     email — so an admin who screenshots the network response
//     doesn't expose the real address.
//   * Detail view (T2) returns the full email + shipping address;
//     admins need them to do their job. The ledger of who looked
//     at what lives in req.log.
//   * Logs (req.log) carry userId + counts + adminEmail only —
//     NEVER customer email, address, item names, or review bodies.
//   * No image logging anywhere (per replit.md rule).
//
// Why no resupply.audit_log writes here:
//   This module mirrors the local convention in
//   artifacts/resupply-api/src/routes/admin/. shop-orders.ts,
//   shop-reviews.ts, and abandoned-carts.ts also emit only
//   req.log entries and do NOT write to resupply.audit_log. The
//   audit_log table is reserved for patient-PHI operations (see
//   /patients/*). Shop is not patient-PHI surface.
//
// Lifetime value:
//   Sums shop_orders.amount_total_cents over rows where
//   paid_at IS NOT NULL AND status <> 'refunded'. Pending orders
//   are excluded (no money has changed hands yet). Refunded orders
//   are excluded (money was returned). This matches what an admin
//   intuitively means by "how much has this customer spent with us".

import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";

import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

/**
 * Partially redact an email so the local-part is hidden but the
 * shape (length, domain) remains recognisable for triage.
 *
 *   "jane.doe@example.com" -> "ja******@example.com"
 *   "ab@x.io"              -> "ab@x.io" (local-part already <=2 chars)
 *   "a@x.io"               -> "a@x.io"
 *   ""                     -> null
 *   null/undefined         -> null
 *
 * Mirrors the helper in admin/abandoned-carts.ts on purpose; if we
 * ever extract a shared `lib/redact-email`, both call sites should
 * move together.
 */
function redactEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const at = e.indexOf("@");
  if (at <= 0) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length <= 2) return `${local}@${domain}`;
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(local.length - 2)}@${domain}`;
}

const listQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .default(PAGE_SIZE_DEFAULT),
  sortBy: z
    .enum(["last_order", "lifetime_value", "created_at"])
    .default("last_order"),
  order: z.enum(["asc", "desc"]).default("desc"),
  subscription: z.enum(["active", "none"]).optional(),
  /**
   * Phase 9 — restrict the directory to customers with an in-app
   * conversation currently in `awaiting_admin` status (the customer
   * is waiting on a CSR reply). Coerced from the URL query string,
   * so `?awaitingReply=1` and `?awaitingReply=true` both work; any
   * other value is treated as falsy.
   */
  awaitingReply: z
    .union([z.literal("1"), z.literal("true")])
    .optional()
    .transform((v) => v !== undefined),
});

interface ListRow {
  user_id: string;
  display_name: string | null;
  email_lower: string | null;
  stripe_customer_id: string | null;
  created_at: string | Date;
  orders_count: number;
  lifetime_value_cents: number;
  last_order_at: string | Date | null;
  has_active_subscription: boolean;
  /**
   * Phase 9: true when the customer's in-app conversation is in
   * `awaiting_admin` status. Drives the "Awaiting reply" badge on
   * the directory + the new `?awaitingReply=1` filter.
   */
  in_app_needs_reply: boolean;
}

router.get("/admin/shop/customers", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_query",
      details: parsed.error.issues.map((i) => i.message),
    });
    return;
  }
  const { q, page, pageSize, sortBy, order, subscription, awaitingReply } =
    parsed.data;
  const offset = (page - 1) * pageSize;

  // ILIKE pattern is built from a trimmed/length-capped Zod-validated
  // input; passed as a bound parameter (NOT interpolated into SQL).
  const qPattern = q ? `%${q.toLowerCase()}%` : null;
  const subFilter = subscription ?? null;

  // Dynamic ORDER BY built from a closed enum (Zod-validated above),
  // so this cannot be hijacked by user input.
  const orderClauseExpr = (() => {
    switch (sortBy) {
      case "lifetime_value":
        return sql`COALESCE(o.lifetime_cents, 0)`;
      case "created_at":
        return sql`c.created_at`;
      case "last_order":
      default:
        return sql`o.last_order_at`;
    }
  })();
  const orderDirSql =
    order === "asc" ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;

  const db = drizzle(getDbPool());

  // Single round-trip aggregation using inline CTEs. shop_customers
  // drives the FROM (registered customers only); the two LEFT JOINs
  // bring in per-customer order rollup and an "any active sub" flag.
  // Tie-break by customer_id for stable pagination across pages
  // when the primary sort key has duplicates (e.g. lifetime=0).
  const awaitingReplyFilterSql = awaitingReply ? sql`true` : sql`false`;

  const listResult = (await db.execute(sql`
    WITH order_agg AS (
      SELECT
        customer_id,
        COUNT(*)::int AS orders_count,
        COALESCE(SUM(amount_total_cents) FILTER (
          WHERE paid_at IS NOT NULL AND status <> 'refunded'
        ), 0)::int AS lifetime_cents,
        MAX(created_at) AS last_order_at
      FROM resupply.shop_orders
      WHERE customer_id IS NOT NULL
      GROUP BY customer_id
    ),
    sub_agg AS (
      SELECT customer_id, true AS has_active
      FROM resupply.shop_subscriptions
      WHERE status = 'active'
      GROUP BY customer_id
    ),
    -- Phase 9: which customers have an in-app conversation currently
    -- in awaiting_admin? The partial index added in 0033 keeps this
    -- LEFT JOIN cheap (one row per customer at most). DISTINCT in
    -- case a future "multi-thread per customer" policy lands.
    needs_reply_agg AS (
      SELECT DISTINCT customer_id
      FROM resupply.conversations
      WHERE channel = 'in_app'
        AND status = 'awaiting_admin'
        AND customer_id IS NOT NULL
    )
    SELECT
      c.customer_id              AS user_id,
      c.display_name               AS display_name,
      c.email_lower                AS email_lower,
      c.stripe_customer_id         AS stripe_customer_id,
      c.created_at                 AS created_at,
      COALESCE(o.orders_count, 0)  AS orders_count,
      COALESCE(o.lifetime_cents, 0) AS lifetime_value_cents,
      o.last_order_at              AS last_order_at,
      COALESCE(s.has_active, false) AS has_active_subscription,
      (n.customer_id IS NOT NULL)  AS in_app_needs_reply
    FROM resupply.shop_customers c
    LEFT JOIN order_agg o ON o.customer_id = c.customer_id
    LEFT JOIN sub_agg s   ON s.customer_id = c.customer_id
    LEFT JOIN needs_reply_agg n ON n.customer_id = c.customer_id
    WHERE (${qPattern}::text IS NULL OR c.email_lower ILIKE ${qPattern})
      AND (
        ${subFilter}::text IS NULL
        OR (${subFilter}::text = 'active' AND s.has_active IS TRUE)
        OR (${subFilter}::text = 'none' AND s.has_active IS NOT TRUE)
      )
      AND (${awaitingReplyFilterSql} = false OR n.customer_id IS NOT NULL)
    ORDER BY ${orderClauseExpr} ${orderDirSql}, c.customer_id ASC
    LIMIT ${Math.min(pageSize, 200)} OFFSET ${offset}
  `)) as unknown as { rows: ListRow[] };

  // Total count (same WHERE) — separate query because the LIMIT/OFFSET
  // page would otherwise hide the true total for pagination UX.
  const totalResult = (await db.execute(sql`
    WITH sub_agg AS (
      SELECT customer_id, true AS has_active
      FROM resupply.shop_subscriptions
      WHERE status = 'active'
      GROUP BY customer_id
    ),
    needs_reply_agg AS (
      SELECT DISTINCT customer_id
      FROM resupply.conversations
      WHERE channel = 'in_app'
        AND status = 'awaiting_admin'
        AND customer_id IS NOT NULL
    )
    SELECT COUNT(*)::int AS total
    FROM resupply.shop_customers c
    LEFT JOIN sub_agg s ON s.customer_id = c.customer_id
    LEFT JOIN needs_reply_agg n ON n.customer_id = c.customer_id
    WHERE (${qPattern}::text IS NULL OR c.email_lower ILIKE ${qPattern})
      AND (
        ${subFilter}::text IS NULL
        OR (${subFilter}::text = 'active' AND s.has_active IS TRUE)
        OR (${subFilter}::text = 'none' AND s.has_active IS NOT TRUE)
      )
      AND (${awaitingReplyFilterSql} = false OR n.customer_id IS NOT NULL)
  `)) as unknown as { rows: Array<{ total: number }> };

  const total = totalResult.rows[0]?.total ?? 0;

  // Safe log: counts + flags + adminEmail. NO email, name, address.
  req.log?.info(
    {
      count: listResult.rows.length,
      total,
      page,
      pageSize,
      sortBy,
      qPresent: !!q,
      hasSubFilter: !!subscription,
      awaitingReplyFilter: awaitingReply,
      adminEmail: req.adminEmail,
    },
    "admin.shop.customers.list",
  );

  res.json({
    customers: listResult.rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      emailRedacted: redactEmail(r.email_lower),
      stripeCustomerId: r.stripe_customer_id,
      ordersCount: r.orders_count,
      lifetimeValueCents: r.lifetime_value_cents,
      lastOrderAt: r.last_order_at
        ? new Date(r.last_order_at).toISOString()
        : null,
      hasActiveSubscription: r.has_active_subscription,
      inAppNeedsReply: r.in_app_needs_reply,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total,
    page,
    pageSize,
  });
});

// =====================================================================
// GET /admin/shop/customers/:userId — single customer profile.
// =====================================================================

interface CustomerRow {
  user_id: string;
  display_name: string | null;
  email_lower: string | null;
  stripe_customer_id: string | null;
  shipping_address_json: unknown;
  default_payment_method_brand: string | null;
  default_payment_method_last4: string | null;
  default_payment_method_exp_month: number | null;
  default_payment_method_exp_year: number | null;
  /**
   * Clinical info added in migration 0032 (PR #52): the customer's
   * CPAP machine + prescribing physician. Both nullable until the
   * customer fills the form out on /account.
   */
  cpap_device_json: unknown;
  physician_info_json: unknown;
  facial_measurements_json: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

interface InAppConversationRow {
  id: string;
  status: string;
  last_message_at: string | Date | null;
  created_at: string | Date;
  message_count: number;
  /**
   * Number of inbound messages from the customer that arrived AFTER
   * the most-recent outbound CSR reply. Drives the "X new from
   * customer" badge in the admin UI. When there's no CSR reply yet
   * (a brand-new thread) this counts every inbound message.
   */
  unread_from_customer: number;
  last_inbound_at: string | Date | null;
  last_outbound_at: string | Date | null;
}

interface OrderRow {
  id: string;
  stripe_session_id: string;
  stripe_payment_intent_id: string | null;
  status: string;
  amount_total_cents: number | null;
  currency: string | null;
  created_at: string | Date;
  paid_at: string | Date | null;
  shipped_at: string | Date | null;
  delivered_at: string | Date | null;
  tracking_carrier: string | null;
  tracking_number: string | null;
  shipping_address_json: unknown;
  item_count: number;
}

interface SubscriptionRow {
  id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  status: string;
  items: unknown;
  current_period_end: string | Date | null;
  cancel_at_period_end: boolean;
  canceled_at: string | Date | null;
  initial_amount_total_cents: number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface AbandonedCartRow {
  id: string;
  items: unknown;
  subtotal_cents: number;
  currency: string;
  updated_at: string | Date;
  reminded_at: string | Date | null;
  recovered_at: string | Date | null;
  cleared_at: string | Date | null;
  created_at: string | Date;
}

interface ReviewRow {
  id: string;
  product_id: string;
  rating: number;
  title: string | null;
  body: string;
  status: string;
  moderation_note: string | null;
  moderated_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface StatsRow {
  orders_count: number;
  lifetime_value_cents: number;
  first_order_at: string | Date | null;
  last_order_at: string | Date | null;
  pending_reviews_count: number;
}

const userIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // Auth-provider user ids are opaque; keep the gate loose but
  // reject anything that looks shaped like a SQL injection probe.
  // The query itself uses parameter binding, this is belt-and-braces.
  .regex(/^[A-Za-z0-9_-]+$/);

router.get("/admin/shop/customers/:userId", requireAdmin, async (req, res) => {
  const parsed = userIdParam.safeParse(req.params.userId);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_user_id" });
    return;
  }
  const userId = parsed.data;
  const db = drizzle(getDbPool());

  // 1. Customer mirror row (may be missing for guest-only users).
  const customerResult = (await db.execute(sql`
      SELECT
        customer_id                     AS user_id,
        display_name                      AS display_name,
        email_lower                       AS email_lower,
        stripe_customer_id                AS stripe_customer_id,
        shipping_address_json             AS shipping_address_json,
        default_payment_method_brand      AS default_payment_method_brand,
        default_payment_method_last4      AS default_payment_method_last4,
        default_payment_method_exp_month  AS default_payment_method_exp_month,
        default_payment_method_exp_year   AS default_payment_method_exp_year,
        cpap_device_json                  AS cpap_device_json,
        physician_info_json               AS physician_info_json,
        facial_measurements_json          AS facial_measurements_json,
        created_at                        AS created_at,
        updated_at                        AS updated_at
      FROM resupply.shop_customers
      WHERE customer_id = ${userId}
      LIMIT 1
    `)) as unknown as { rows: CustomerRow[] };
  const customerRow = customerResult.rows[0] ?? null;

  // 2. Recent orders (cap 25). Item count is computed by a
  //    correlated subquery so we don't need a second round-trip.
  const ordersResult = (await db.execute(sql`
      SELECT
        o.id                       AS id,
        o.stripe_session_id        AS stripe_session_id,
        o.stripe_payment_intent_id AS stripe_payment_intent_id,
        o.status                   AS status,
        o.amount_total_cents       AS amount_total_cents,
        o.currency                 AS currency,
        o.created_at               AS created_at,
        o.paid_at                  AS paid_at,
        o.shipped_at               AS shipped_at,
        o.delivered_at             AS delivered_at,
        o.tracking_carrier         AS tracking_carrier,
        o.tracking_number          AS tracking_number,
        o.shipping_address_json    AS shipping_address_json,
        COALESCE((
          SELECT SUM(i.quantity)::int
          FROM resupply.shop_order_items i
          WHERE i.order_id = o.id
        ), 0)                      AS item_count
      FROM resupply.shop_orders o
      WHERE o.customer_id = ${userId}
      ORDER BY o.created_at DESC
      LIMIT 25
    `)) as unknown as { rows: OrderRow[] };

  // True 404 — neither a customer record nor any orders.
  if (!customerRow && ordersResult.rows.length === 0) {
    req.log?.info(
      { userId, adminEmail: req.adminEmail },
      "admin.shop.customers.detail.not_found",
    );
    res.status(404).json({ error: "customer_not_found" });
    return;
  }

  // 3. Subscriptions (typically 0–2 per customer; no LIMIT needed).
  const subsResult = (await db.execute(sql`
      SELECT
        id                          AS id,
        stripe_subscription_id      AS stripe_subscription_id,
        stripe_customer_id          AS stripe_customer_id,
        status                      AS status,
        items                       AS items,
        current_period_end          AS current_period_end,
        cancel_at_period_end        AS cancel_at_period_end,
        canceled_at                 AS canceled_at,
        initial_amount_total_cents  AS initial_amount_total_cents,
        created_at                  AS created_at,
        updated_at                  AS updated_at
      FROM resupply.shop_subscriptions
      WHERE customer_id = ${userId}
      ORDER BY created_at DESC
    `)) as unknown as { rows: SubscriptionRow[] };

  // 4. Abandoned cart (UNIQUE(customer_id) — at most 1).
  const cartResult = (await db.execute(sql`
      SELECT
        id              AS id,
        items           AS items,
        subtotal_cents  AS subtotal_cents,
        currency        AS currency,
        updated_at      AS updated_at,
        reminded_at     AS reminded_at,
        recovered_at    AS recovered_at,
        cleared_at      AS cleared_at,
        created_at      AS created_at
      FROM resupply.shop_abandoned_carts
      WHERE customer_id = ${userId}
      LIMIT 1
    `)) as unknown as { rows: AbandonedCartRow[] };

  // 5. Reviews (typically a handful; cap at 100 for safety).
  const reviewsResult = (await db.execute(sql`
      SELECT
        id              AS id,
        product_id      AS product_id,
        rating          AS rating,
        title           AS title,
        body            AS body,
        status          AS status,
        moderation_note AS moderation_note,
        moderated_at    AS moderated_at,
        created_at      AS created_at,
        updated_at      AS updated_at
      FROM resupply.shop_reviews
      WHERE customer_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 100
    `)) as unknown as { rows: ReviewRow[] };

  // 6a. In-app conversation thread (added in PR #53 / migration 0033).
  //     At most one row per customer (single-thread-per-customer
  //     policy enforced by appendCustomerMessage). The message_count
  //     and unread_from_customer crumbs let the admin UI render
  //     "5 messages · 2 new from customer" without a second
  //     round-trip. unread_from_customer counts inbound messages
  //     that landed AFTER the most-recent CSR reply (or every
  //     inbound message when there's no CSR reply yet).
  const inAppResult = (await db.execute(sql`
      WITH conv AS (
        SELECT id, status, last_message_at, created_at
        FROM resupply.conversations
        WHERE customer_id = ${userId}
          AND channel = 'in_app'
        ORDER BY created_at ASC
        LIMIT 1
      ),
      max_outbound AS (
        SELECT m.conversation_id, MAX(m.created_at) AS max_at
        FROM resupply.messages m
        JOIN conv c ON c.id = m.conversation_id
        WHERE m.direction = 'outbound'
        GROUP BY m.conversation_id
      ),
      msg_stats AS (
        SELECT
          c.id AS conversation_id,
          COUNT(m.id)::int AS message_count,
          MAX(m.created_at) FILTER (WHERE m.direction = 'inbound')
            AS last_inbound_at,
          MAX(m.created_at) FILTER (WHERE m.direction = 'outbound')
            AS last_outbound_at,
          COUNT(m.id) FILTER (
            WHERE m.direction = 'inbound'
              AND m.created_at > COALESCE(mo.max_at, '-infinity'::timestamptz)
          )::int AS unread_from_customer
        FROM conv c
        LEFT JOIN resupply.messages m ON m.conversation_id = c.id
        LEFT JOIN max_outbound mo ON mo.conversation_id = c.id
        GROUP BY c.id, mo.max_at
      )
      SELECT
        c.id                       AS id,
        c.status                   AS status,
        c.last_message_at          AS last_message_at,
        c.created_at               AS created_at,
        COALESCE(s.message_count, 0)        AS message_count,
        COALESCE(s.unread_from_customer, 0) AS unread_from_customer,
        s.last_inbound_at          AS last_inbound_at,
        s.last_outbound_at         AS last_outbound_at
      FROM conv c
      LEFT JOIN msg_stats s ON s.conversation_id = c.id
    `)) as unknown as { rows: InAppConversationRow[] };
  const inAppRow = inAppResult.rows[0] ?? null;

  // 6. Lifetime stats — over ALL orders (not just the recent 25
  //    we returned), so the headline numbers are honest.
  const statsResult = (await db.execute(sql`
      WITH paid AS (
        SELECT amount_total_cents, created_at
        FROM resupply.shop_orders
        WHERE customer_id = ${userId}
          AND paid_at IS NOT NULL
          AND status <> 'refunded'
      )
      SELECT
        (SELECT COUNT(*)::int FROM resupply.shop_orders
         WHERE customer_id = ${userId})                    AS orders_count,
        COALESCE((SELECT SUM(amount_total_cents)::int FROM paid), 0)
                                                              AS lifetime_value_cents,
        (SELECT MIN(created_at) FROM paid)                    AS first_order_at,
        (SELECT MAX(created_at) FROM paid)                    AS last_order_at,
        (SELECT COUNT(*)::int FROM resupply.shop_reviews
         WHERE customer_id = ${userId}
           AND status = 'pending')                            AS pending_reviews_count
    `)) as unknown as { rows: StatsRow[] };

  const statsRow = statsResult.rows[0] ?? {
    orders_count: 0,
    lifetime_value_cents: 0,
    first_order_at: null,
    last_order_at: null,
    pending_reviews_count: 0,
  };

  // Synthesize a minimal customer object for guest-only userIds.
  // Pull the most-recent order's shipping address as a best-guess
  // contact display so the admin doesn't see "Unknown customer"
  // when there's clear order history to act on.
  const guestSynth = !customerRow && ordersResult.rows.length > 0;
  const customer = customerRow
    ? {
        userId: customerRow.user_id,
        displayName: customerRow.display_name,
        email: customerRow.email_lower,
        stripeCustomerId: customerRow.stripe_customer_id,
        shippingAddress: customerRow.shipping_address_json ?? null,
        defaultPaymentMethod: customerRow.default_payment_method_brand
          ? {
              brand: customerRow.default_payment_method_brand,
              last4: customerRow.default_payment_method_last4,
              expMonth: customerRow.default_payment_method_exp_month,
              expYear: customerRow.default_payment_method_exp_year,
            }
          : null,
        // Clinical info — added in PR #52, surfaced here so the CSR
        // can answer "what device does this customer have?" and
        // "who's their prescriber?" without bouncing to another
        // page. Both nullable until the customer fills the form
        // out on /account.
        clinicalInfo: {
          cpapDevice: customerRow.cpap_device_json ?? null,
          physicianInfo: customerRow.physician_info_json ?? null,
          // Latest on-device fitter scan (PR #66). Null until the
          // customer completes a fitter order while signed in.
          facialMeasurements: customerRow.facial_measurements_json ?? null,
        },
        createdAt: new Date(customerRow.created_at).toISOString(),
        updatedAt: new Date(customerRow.updated_at).toISOString(),
        isGuest: false as const,
      }
    : {
        userId,
        displayName: null,
        email: null,
        stripeCustomerId: null,
        shippingAddress: ordersResult.rows[0]?.shipping_address_json ?? null,
        defaultPaymentMethod: null,
        // Guest checkouts have no shop_customers row, so they
        // can't have stored clinical info. Surface explicit nulls
        // so the UI doesn't have to special-case `clinicalInfo`
        // being undefined.
        clinicalInfo: {
          cpapDevice: null,
          physicianInfo: null,
          facialMeasurements: null,
        },
        createdAt: ordersResult.rows[ordersResult.rows.length - 1]
          ? new Date(
              ordersResult.rows[ordersResult.rows.length - 1]!.created_at,
            ).toISOString()
          : new Date().toISOString(),
        updatedAt: ordersResult.rows[0]
          ? new Date(ordersResult.rows[0]!.created_at).toISOString()
          : new Date().toISOString(),
        isGuest: true as const,
      };

  const ordersCount = statsRow.orders_count;
  const lifetimeValueCents = statsRow.lifetime_value_cents;
  const avgOrderValueCents =
    ordersCount > 0 ? Math.round(lifetimeValueCents / ordersCount) : 0;

  req.log?.info(
    {
      userId,
      ordersCount,
      subscriptionsCount: subsResult.rows.length,
      reviewsCount: reviewsResult.rows.length,
      hasAbandonedCart: cartResult.rows.length > 0,
      guestSynth,
      adminEmail: req.adminEmail,
    },
    "admin.shop.customers.detail",
  );

  res.json({
    customer,
    orders: ordersResult.rows.map((o) => ({
      id: o.id,
      stripeSessionId: o.stripe_session_id,
      stripePaymentIntentId: o.stripe_payment_intent_id,
      status: o.status,
      amountTotalCents: o.amount_total_cents,
      currency: o.currency,
      createdAt: new Date(o.created_at).toISOString(),
      paidAt: o.paid_at ? new Date(o.paid_at).toISOString() : null,
      shippedAt: o.shipped_at ? new Date(o.shipped_at).toISOString() : null,
      deliveredAt: o.delivered_at
        ? new Date(o.delivered_at).toISOString()
        : null,
      trackingCarrier: o.tracking_carrier,
      trackingNumber: o.tracking_number,
      shippingAddress: o.shipping_address_json ?? null,
      itemCount: o.item_count,
    })),
    subscriptions: subsResult.rows.map((s) => ({
      id: s.id,
      stripeSubscriptionId: s.stripe_subscription_id,
      stripeCustomerId: s.stripe_customer_id,
      status: s.status,
      items: s.items ?? [],
      currentPeriodEnd: s.current_period_end
        ? new Date(s.current_period_end).toISOString()
        : null,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      canceledAt: s.canceled_at ? new Date(s.canceled_at).toISOString() : null,
      initialAmountTotalCents: s.initial_amount_total_cents,
      createdAt: new Date(s.created_at).toISOString(),
      updatedAt: new Date(s.updated_at).toISOString(),
    })),
    abandonedCart: cartResult.rows[0]
      ? {
          id: cartResult.rows[0].id,
          items: cartResult.rows[0].items ?? [],
          subtotalCents: cartResult.rows[0].subtotal_cents,
          currency: cartResult.rows[0].currency,
          updatedAt: new Date(cartResult.rows[0].updated_at).toISOString(),
          remindedAt: cartResult.rows[0].reminded_at
            ? new Date(cartResult.rows[0].reminded_at).toISOString()
            : null,
          recoveredAt: cartResult.rows[0].recovered_at
            ? new Date(cartResult.rows[0].recovered_at).toISOString()
            : null,
          clearedAt: cartResult.rows[0].cleared_at
            ? new Date(cartResult.rows[0].cleared_at).toISOString()
            : null,
          createdAt: new Date(cartResult.rows[0].created_at).toISOString(),
        }
      : null,
    reviews: reviewsResult.rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      status: r.status,
      moderationNote: r.moderation_note,
      moderatedAt: r.moderated_at
        ? new Date(r.moderated_at).toISOString()
        : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    stats: {
      ordersCount,
      lifetimeValueCents,
      avgOrderValueCents,
      firstOrderAt: statsRow.first_order_at
        ? new Date(statsRow.first_order_at).toISOString()
        : null,
      lastOrderAt: statsRow.last_order_at
        ? new Date(statsRow.last_order_at).toISOString()
        : null,
      pendingReviewsCount: statsRow.pending_reviews_count,
    },
    /**
     * In-app conversation summary — added in PR #54 (this PR).
     * Null when the customer has never messaged customer service.
     * The `id` field can be plugged into the existing
     * /admin/conversations/:id detail page for the full thread +
     * reply composer; the `unreadFromCustomer` count drives the
     * "X new from customer" badge in the admin UI.
     */
    inAppConversation: inAppRow
      ? {
          id: inAppRow.id,
          status: inAppRow.status,
          messageCount: inAppRow.message_count,
          unreadFromCustomer: inAppRow.unread_from_customer,
          lastMessageAt: inAppRow.last_message_at
            ? new Date(inAppRow.last_message_at).toISOString()
            : null,
          lastInboundAt: inAppRow.last_inbound_at
            ? new Date(inAppRow.last_inbound_at).toISOString()
            : null,
          lastOutboundAt: inAppRow.last_outbound_at
            ? new Date(inAppRow.last_outbound_at).toISOString()
            : null,
          createdAt: new Date(inAppRow.created_at).toISOString(),
        }
      : null,
  });
});

// =====================================================================
// POST /admin/shop/customers/:userId/reorder
// =====================================================================
//
// Builds a fresh Stripe Checkout Session populated with the line
// items from a paid past order belonging to this customer, and
// returns the session URL. The admin shares the URL with the
// customer out-of-band (email, SMS, phone callback) — we do NOT
// auto-charge the saved card. Reasons:
//   * Off-session charges via PaymentIntents require explicit
//     re-auth flows for SCA-regulated regions and a clean consent
//     record. A shareable Checkout link sidesteps both.
//   * The customer sees current pricing, can adjust quantities, and
//     supplies their own address confirmation. That's the
//     "trustworthy" reorder UX a Stripe-shareable URL gives us for
//     free.
//
// We never write to local rows here. The webhook (checkout.session
// .completed) handles the authoritative shop_orders insert just
// like any other purchase. Metadata on the session marks it as an
// admin-initiated reorder so analytics can attribute it correctly.

const reorderBody = z.object({
  sourceOrderId: z.string().trim().min(1).max(200),
});

interface SourceOrderRow {
  id: string;
  status: string;
  paid_at: string | Date | null;
  customer_id: string | null;
}

interface ItemRow {
  price_id: string;
  quantity: number;
}

interface CustomerLookupRow {
  email_lower: string | null;
  stripe_customer_id: string | null;
}

router.post(
  "/admin/shop/customers/:userId/reorder",
  requireAdmin,
  async (req, res) => {
    const idCheck = userIdParam.safeParse(req.params.userId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = idCheck.data;

    const bodyCheck = reorderBody.safeParse(req.body);
    if (!bodyCheck.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyCheck.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { sourceOrderId } = bodyCheck.data;

    const db = drizzle(getDbPool());

    // 1. Look up the source order. Must belong to this userId AND
    //    be paid AND not refunded.
    const orderResult = (await db.execute(sql`
      SELECT id, status, paid_at, customer_id
      FROM resupply.shop_orders
      WHERE id = ${sourceOrderId}
      LIMIT 1
    `)) as unknown as { rows: SourceOrderRow[] };

    const order = orderResult.rows[0];
    if (!order) {
      res.status(404).json({ error: "source_order_not_found" });
      return;
    }
    if (order.customer_id !== userId) {
      // Don't leak whether the id exists at all; treat
      // ownership-mismatch as a generic 400.
      res.status(400).json({ error: "source_order_user_mismatch" });
      return;
    }
    if (!order.paid_at || order.status === "refunded") {
      res.status(400).json({
        error: "source_order_not_reorderable",
        currentStatus: order.status,
      });
      return;
    }

    // 2. Pull the source order's line items.
    const itemsResult = (await db.execute(sql`
      SELECT price_id, quantity
      FROM resupply.shop_order_items
      WHERE order_id = ${sourceOrderId}
        AND price_id IS NOT NULL
        AND price_id <> ''
        AND quantity > 0
    `)) as unknown as { rows: ItemRow[] };

    if (itemsResult.rows.length === 0) {
      res.status(400).json({ error: "source_order_has_no_items" });
      return;
    }

    // 3. Look up the customer mirror to decide between `customer`
    //    (preferred — keeps Stripe analytics linked) and
    //    `customer_email` (fallback for guest-checkout-only ids).
    const customerResult = (await db.execute(sql`
      SELECT email_lower, stripe_customer_id
      FROM resupply.shop_customers
      WHERE customer_id = ${userId}
      LIMIT 1
    `)) as unknown as { rows: CustomerLookupRow[] };
    const customerLookup = customerResult.rows[0] ?? null;

    // 4. Stripe is required from here down. In preview/dev (no
    //    secret + no public base url), surface a clean 503 the UI
    //    can render as an explainer.
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const stripe = getStripeClient(config);

    // Mirror the customer-facing success URL contract used by
    // routes/shop/checkout.ts so the post-payment landing page exists
    // and the session_id query param is parsed by the standard
    // shop-checkout-success view.
    const successUrl = `${config.publicBaseUrl}/shop/checkout-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${config.publicBaseUrl}/shop`;

    let session;
    try {
      // Per-(user, source order) idempotency key. Two admin clicks on
      // the "Reorder" button for the same customer + same source
      // collapse to a single Stripe Checkout Session within Stripe's
      // 24h idempotency window, so the customer doesn't end up with
      // two competing payment links in their inbox. After 24h the key
      // expires and a fresh retry produces a new session — the
      // typical interval where a CSR might legitimately re-issue
      // because the original link expired or was lost.
      const idempotencyKey = `admin-reorder-${userId}-${sourceOrderId}`;
      session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: itemsResult.rows.map((it) => ({
            price: it.price_id,
            quantity: it.quantity,
          })),
          success_url: successUrl,
          cancel_url: cancelUrl,
          shipping_address_collection: { allowed_countries: ["US"] },
          phone_number_collection: { enabled: true },
          ...(customerLookup?.stripe_customer_id
            ? {
                customer: customerLookup.stripe_customer_id,
                customer_update: {
                  shipping: "auto",
                  address: "auto",
                  name: "auto",
                },
              }
            : customerLookup?.email_lower
              ? { customer_email: customerLookup.email_lower }
              : {}),
          metadata: {
            source: "pennpaps-admin-reorder",
            // The reorder_for_user_id stamp lets the webhook attribute
            // the resulting shop_order row to the right customer even
            // if the email/Stripe-customer linkage is novel.
            customer_id: userId,
            reorder_source_order_id: sourceOrderId,
            initiated_by_admin: req.adminEmail ?? "unknown",
            initiated_by_admin_user_id: req.adminUserId ?? "unknown",
          },
        },
        { idempotencyKey },
      );
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          userId,
          sourceOrderId,
          err: err instanceof Error ? err.message : String(err),
        },
        "admin/shop/customers: stripe checkout.sessions.create failed",
      );
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: "stripe_checkout_failed" });
      return;
    }

    if (!session.url) {
      // Stripe is supposed to always return a URL for hosted-mode
      // sessions; if it doesn't, the link is unusable and we've
      // wasted nothing — surface the unexpected condition.
      req.log?.warn?.(
        { userId, sourceOrderId, sessionId: session.id },
        "admin/shop/customers: stripe session missing url",
      );
      res.status(502).json({ error: "stripe_checkout_missing_url" });
      return;
    }

    req.log?.info?.(
      {
        userId,
        sourceOrderId,
        sessionId: session.id,
        lineItemCount: itemsResult.rows.length,
        adminEmail: req.adminEmail,
      },
      "admin.shop.customers.reorder",
    );

    res.json({
      checkoutUrl: session.url,
      sessionId: session.id,
      // expires_at is a Stripe unix timestamp; surface as ISO so the
      // UI doesn't have to decide a format.
      expiresAt: session.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : null,
    });
  },
);

export default router;
