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
//   * No image logging anywhere (per CLAUDE.md "Hard rules").
//
// Lifetime value:
//   Sums shop_orders.amount_total_cents over rows where
//   paid_at IS NOT NULL AND status <> 'refunded'. Pending orders
//   are excluded (no money has changed hands yet). Refunded orders
//   are excluded (money was returned). This matches what an admin
//   intuitively means by "how much has this customer spent with us".
//
// PostgREST-specific notes:
//   The original SQL path used a single CTE per endpoint
//   (CTEs + LEFT JOINs + GROUP BY + FILTER aggregates). PostgREST
//   exposes none of those, so each call site does a few small
//   parallel reads and aggregates JS-side. Datasets are bounded —
//   this is admin-only — so a few-thousand-row scan is acceptable.
//   When customer count grows past that, this becomes the natural
//   first place to plant a stored-function RPC.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  escapePostgRESTContainsPattern,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

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

// Customer 360 list — `conversations.manage` scope (admin /
// supervisor / csr / agent). Removes fitter / fulfillment /
// compliance_officer who don't drive this surface today.
router.get(
  "/admin/shop/customers",
  requirePermission("conversations.manage"),
  async (req, res) => {
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

    const supabase = getSupabaseServiceRoleClient();

    // ── Phase 1: pull the candidate customer set ────────────────────
    // PostgREST has neither CTEs nor GROUP BY, so the rollups
    // (orders_count / lifetime_value / has_active_sub /
    // in_app_needs_reply) are computed JS-side after small bulk
    // fetches. The candidate set is bounded by q-ilike + the implicit
    // filter "must have a shop_customers row" — admin-only path, so
    // a full scan at PennPaps scale is acceptable.
    // Keyset-page the candidate read up to an explicit, VISIBLE cap.
    // The previous un-limited select was silently truncated at the
    // PostgREST server's max-rows (~1000 on hosted Supabase): past
    // 1000 customers, later rows simply never appeared in the
    // directory, `total` under-reported, and the rollup sorts were
    // wrong — with no signal anywhere. An explicit `.limit()` can't
    // bypass max-rows, so we PAGE on customer_id; past the cap we set
    // `truncated: true` in the response and log a warn so the gap is
    // operator-visible rather than silent.
    const READ_CAP = 5000;
    const READ_PAGE = 1000;
    type CustomerRow = {
      customer_id: string;
      display_name: string | null;
      email_lower: string | null;
      stripe_customer_id: string | null;
      created_at: string;
    };
    const customerRows: CustomerRow[] = [];
    let truncated = false;
    let readCursor: string | null = null;
    for (;;) {
      let customersQuery = supabase
        .schema("resupply")
        .from("shop_customers")
        .select(
          "customer_id, display_name, email_lower, stripe_customer_id, created_at",
        )
        .order("customer_id", { ascending: true })
        .limit(READ_PAGE);
      if (readCursor !== null) {
        customersQuery = customersQuery.gt("customer_id", readCursor);
      }
      if (q) {
        // Match on email OR display name so the directory is searchable by
        // who the person is, not just their address (this also powers the
        // "find this person in Customers" jump from a patient record).
        // escapePostgRESTContainsPattern handles LIKE metacharacters and
        // .or() delimiters, with the `*` wildcards INSIDE the quoting
        // layer (a hand-rolled `*${escaped}*` mis-parses for searches
        // containing commas/parens/quotes). ILIKE is case-insensitive,
        // so a lowercased needle still matches a mixed-case
        // display_name; email_lower is already stored lowercase.
        const pattern = escapePostgRESTContainsPattern(q.toLowerCase());
        customersQuery = customersQuery.or(
          `email_lower.ilike.${pattern},display_name.ilike.${pattern}`,
        );
      }
      const { data: pageRows, error: customersErr } = await customersQuery;
      if (customersErr) throw customersErr;
      if (!pageRows || pageRows.length === 0) break;
      customerRows.push(...(pageRows as CustomerRow[]));
      readCursor = pageRows[pageRows.length - 1]!.customer_id;
      if (customerRows.length >= READ_CAP) {
        truncated = true;
        req.log?.warn(
          { readCap: READ_CAP, qPresent: !!q },
          "admin.shop.customers.list: candidate read hit READ_CAP — directory truncated",
        );
        break;
      }
      if (pageRows.length < READ_PAGE) break;
    }

    const customerIds = customerRows.map((c) => c.customer_id);

    // ── Phase 2: rollup fetches, scoped to the candidate set. The ids
    // are chunked at 200 per request: one giant `.in()` with thousands
    // of UUIDs blows the PostgREST querystring limit, and the
    // shop_orders rollup itself can exceed max-rows for a big chunk —
    // so the orders fan-out also keyset-pages WITHIN each chunk (a
    // customer set's full order history must be complete or the LTV /
    // last-order sorts silently undercount). ────
    const ID_CHUNK = 200;
    const idChunks: string[][] = [];
    for (let i = 0; i < customerIds.length; i += ID_CHUNK) {
      idChunks.push(customerIds.slice(i, i + ID_CHUNK));
    }
    type OrdersRollupRow = {
      customer_id: string | null;
      amount_total_cents: number | null;
      paid_at: string | null;
      status: string;
      created_at: string | null;
    };
    const ordersRollupRows: OrdersRollupRow[] = [];
    const activeSubRows: Array<{ customer_id: string | null }> = [];
    const awaitingReplyRows: Array<{ customer_id: string | null }> = [];
    for (const chunk of idChunks) {
      let ordersCursor: string | null = null;
      for (;;) {
        let ordersQuery = supabase
          .schema("resupply")
          .from("shop_orders")
          .select(
            "id, customer_id, amount_total_cents, paid_at, status, created_at",
          )
          .in("customer_id", chunk)
          .order("id", { ascending: true })
          .limit(READ_PAGE);
        if (ordersCursor !== null) {
          ordersQuery = ordersQuery.gt("id", ordersCursor);
        }
        const { data: ordersPage, error: ordersErr } = await ordersQuery;
        if (ordersErr) throw ordersErr;
        if (!ordersPage || ordersPage.length === 0) break;
        ordersRollupRows.push(...(ordersPage as OrdersRollupRow[]));
        ordersCursor = (ordersPage[ordersPage.length - 1] as { id: string }).id;
        if (ordersPage.length < READ_PAGE) break;
      }
      const [activeSubsRes, awaitingReplyRes] = await Promise.all([
        supabase
          .schema("resupply")
          .from("shop_subscriptions")
          .select("customer_id")
          .eq("status", "active")
          .in("customer_id", chunk),
        supabase
          .schema("resupply")
          .from("conversations")
          .select("customer_id")
          .eq("channel", "in_app")
          .eq("status", "awaiting_admin")
          .in("customer_id", chunk),
      ]);
      if (activeSubsRes.error) throw activeSubsRes.error;
      if (awaitingReplyRes.error) throw awaitingReplyRes.error;
      activeSubRows.push(...(activeSubsRes.data ?? []));
      awaitingReplyRows.push(...(awaitingReplyRes.data ?? []));
    }

    // Bucket the per-customer rollups.
    interface OrderRollup {
      ordersCount: number;
      lifetimeValueCents: number;
      lastOrderAt: string | null;
    }
    const orderRollupByCustomer = new Map<string, OrderRollup>();
    for (const o of ordersRollupRows) {
      const cid = o.customer_id;
      if (!cid) continue;
      const bucket = orderRollupByCustomer.get(cid) ?? {
        ordersCount: 0,
        lifetimeValueCents: 0,
        lastOrderAt: null,
      };
      bucket.ordersCount += 1;
      if (o.paid_at && o.status !== "refunded") {
        bucket.lifetimeValueCents += o.amount_total_cents ?? 0;
      }
      if (
        o.created_at &&
        (!bucket.lastOrderAt || o.created_at > bucket.lastOrderAt)
      ) {
        bucket.lastOrderAt = o.created_at;
      }
      orderRollupByCustomer.set(cid, bucket);
    }
    const activeSubCustomerIds = new Set<string>();
    for (const r of activeSubRows) {
      if (r.customer_id) activeSubCustomerIds.add(r.customer_id);
    }
    const awaitingReplyCustomerIds = new Set<string>();
    for (const r of awaitingReplyRows) {
      if (r.customer_id) awaitingReplyCustomerIds.add(r.customer_id);
    }

    // ── Phase 3: enrich + filter + sort + page JS-side ──────────────
    interface EnrichedRow {
      userId: string;
      displayName: string | null;
      emailLower: string | null;
      stripeCustomerId: string | null;
      createdAt: string;
      ordersCount: number;
      lifetimeValueCents: number;
      lastOrderAt: string | null;
      hasActiveSubscription: boolean;
      inAppNeedsReply: boolean;
    }
    const enriched: EnrichedRow[] = customerRows.map((c) => {
      const rollup = orderRollupByCustomer.get(c.customer_id) ?? {
        ordersCount: 0,
        lifetimeValueCents: 0,
        lastOrderAt: null,
      };
      return {
        userId: c.customer_id,
        displayName: c.display_name,
        emailLower: c.email_lower,
        stripeCustomerId: c.stripe_customer_id,
        createdAt: c.created_at,
        ordersCount: rollup.ordersCount,
        lifetimeValueCents: rollup.lifetimeValueCents,
        lastOrderAt: rollup.lastOrderAt,
        hasActiveSubscription: activeSubCustomerIds.has(c.customer_id),
        inAppNeedsReply: awaitingReplyCustomerIds.has(c.customer_id),
      };
    });

    // Subscription + awaitingReply filters fire AFTER enrichment.
    const filtered = enriched.filter((r) => {
      if (subscription === "active" && !r.hasActiveSubscription) return false;
      if (subscription === "none" && r.hasActiveSubscription) return false;
      if (awaitingReply && !r.inAppNeedsReply) return false;
      return true;
    });

    // Sort. Tie-break by userId for stable pagination. NULLs always
    // sort LAST regardless of ascending/descending, mirroring the
    // SQL `NULLS LAST` clause.
    const sortKey = (r: EnrichedRow): string | number | null => {
      switch (sortBy) {
        case "lifetime_value":
          return r.lifetimeValueCents;
        case "created_at":
          return r.createdAt;
        case "last_order":
        default:
          return r.lastOrderAt;
      }
    };
    const dir = order === "asc" ? 1 : -1;
    const sorted = filtered.slice().sort((a, b) => {
      const av = sortKey(a);
      const bv = sortKey(b);
      if (av === null && bv === null) {
        // Stable tie-break.
        return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
      }
      if (av === null) return 1; // NULLS LAST
      if (bv === null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });

    const total = sorted.length;
    const offset = (page - 1) * pageSize;
    const pageRows = sorted.slice(offset, offset + pageSize);

    req.log?.info(
      {
        count: pageRows.length,
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
      // True when the candidate read hit READ_CAP — the directory and
      // `total` cover only the first READ_CAP customers (narrow the
      // search to see the rest). Silent truncation was the bug.
      truncated,
      customers: pageRows.map((r) => ({
        userId: r.userId,
        displayName: r.displayName,
        emailRedacted: redactEmail(r.emailLower),
        stripeCustomerId: r.stripeCustomerId,
        ordersCount: r.ordersCount,
        lifetimeValueCents: r.lifetimeValueCents,
        lastOrderAt: r.lastOrderAt,
        hasActiveSubscription: r.hasActiveSubscription,
        inAppNeedsReply: r.inAppNeedsReply,
        createdAt: r.createdAt,
      })),
      total,
      page,
      pageSize,
    });
  },
);

// =====================================================================
// GET /admin/shop/customers/:userId — single customer profile.
// =====================================================================

const userIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // Auth-provider user ids are opaque; keep the gate loose but
  // reject anything that looks shaped like a SQL injection probe.
  .regex(/^[A-Za-z0-9_-]+$/);

router.get(
  "/admin/shop/customers/:userId",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = userIdParam.safeParse(req.params.userId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    // Six independent reads (the seventh stat-rollup is computed
    // JS-side from the orders/reviews data we already pull).
    const [
      customerRes,
      ordersRes,
      subsRes,
      cartRes,
      reviewsRes,
      inAppConvRes,
      statsOrdersRes,
      statsPendingReviewsRes,
    ] = await Promise.all([
      // 1. Customer mirror row (may be missing for guest-only users).
      supabase
        .schema("resupply")
        .from("shop_customers")
        .select(
          "customer_id, display_name, email_lower, stripe_customer_id, shipping_address_json, default_payment_method_brand, default_payment_method_last4, default_payment_method_exp_month, default_payment_method_exp_year, cpap_device_json, physician_info_json, facial_measurements_json, created_at, updated_at, auth_user_id",
        )
        .eq("customer_id", userId)
        .limit(1)
        .maybeSingle(),
      // 2. Recent orders (cap 25). Item count is computed below from a
      //    bulk shop_order_items fetch keyed on the page's order ids.
      supabase
        .schema("resupply")
        .from("shop_orders")
        .select(
          "id, stripe_session_id, stripe_payment_intent_id, status, amount_total_cents, currency, created_at, paid_at, shipped_at, delivered_at, tracking_carrier, tracking_number, shipping_address_json",
        )
        .eq("customer_id", userId)
        .order("created_at", { ascending: false })
        .limit(25),
      // 3. Subscriptions (typically 0–2 per customer; no LIMIT needed).
      supabase
        .schema("resupply")
        .from("shop_subscriptions")
        .select(
          "id, stripe_subscription_id, stripe_customer_id, status, items, current_period_end, cancel_at_period_end, canceled_at, initial_amount_total_cents, created_at, updated_at",
        )
        .eq("customer_id", userId)
        .order("created_at", { ascending: false }),
      // 4. Abandoned cart (UNIQUE(customer_id) — at most 1).
      supabase
        .schema("resupply")
        .from("shop_abandoned_carts")
        .select(
          "id, items, subtotal_cents, currency, updated_at, reminded_at, recovered_at, cleared_at, created_at",
        )
        .eq("customer_id", userId)
        .limit(1)
        .maybeSingle(),
      // 5. Reviews (typically a handful; cap at 100 for safety).
      supabase
        .schema("resupply")
        .from("shop_reviews")
        .select(
          "id, product_id, rating, title, body, status, moderation_note, moderated_at, created_at, updated_at",
        )
        .eq("customer_id", userId)
        .order("created_at", { ascending: false })
        .limit(100),
      // 6. In-app conversation (single-thread-per-customer). The full
      //    message stats are computed JS-side from a follow-up
      //    messages fetch keyed on the conversation id below.
      supabase
        .schema("resupply")
        .from("conversations")
        .select("id, status, last_message_at, created_at")
        .eq("customer_id", userId)
        .eq("channel", "in_app")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      // 7a. Lifetime stats — every paid+non-refunded order's
      //     amount_total_cents and created_at. Explicitly bounded:
      //     PostgREST silently truncates un-limited reads at the
      //     server max-rows anyway, so make the cap deliberate and
      //     deterministic (newest-first). One customer exceeding
      //     1000 orders is implausible for a DME shop; if that ever
      //     changes this needs the directory route's paging loop.
      supabase
        .schema("resupply")
        .from("shop_orders")
        .select("amount_total_cents, paid_at, status, created_at")
        .eq("customer_id", userId)
        .order("created_at", { ascending: false })
        .limit(1000),
      // 7b. Pending reviews count (single head-only query — project a
      // single column since head:true discards the row data anyway).
      supabase
        .schema("resupply")
        .from("shop_reviews")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", userId)
        .eq("status", "pending"),
    ]);
    if (customerRes.error) throw customerRes.error;
    if (ordersRes.error) throw ordersRes.error;
    if (subsRes.error) throw subsRes.error;
    if (cartRes.error) throw cartRes.error;
    if (reviewsRes.error) throw reviewsRes.error;
    if (inAppConvRes.error) throw inAppConvRes.error;
    if (statsOrdersRes.error) throw statsOrdersRes.error;
    if (statsPendingReviewsRes.error) throw statsPendingReviewsRes.error;

    const customerRow = customerRes.data ?? null;
    const orderRows = ordersRes.data ?? [];

    // True 404 — neither a customer record nor any orders.
    if (!customerRow && orderRows.length === 0) {
      req.log?.info(
        { userId, adminEmail: req.adminEmail },
        "admin.shop.customers.detail.not_found",
      );
      res.status(404).json({ error: "customer_not_found" });
      return;
    }

    // The clinical patient that shares this customer's portal login, if
    // any. Customers and patients are otherwise unlinked; the only
    // deterministic correlation is a shared in-house auth user
    // (shop_customers.auth_user_id === patients.portal_auth_user_id).
    // Surfacing the patient id lets the detail page offer a real "view
    // their patient record" jump instead of a best-effort name search.
    let linkedPatientId: string | null = null;
    if (customerRow?.auth_user_id) {
      const { data: linkedPatient, error: linkedPatientErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id")
        .eq("portal_auth_user_id", customerRow.auth_user_id)
        .limit(1)
        .maybeSingle();
      if (linkedPatientErr) throw linkedPatientErr;
      linkedPatientId = linkedPatient?.id ?? null;
    }

    // Item-count rollup — one bulk fetch instead of N correlated
    // sub-queries.
    const orderIds = orderRows.map((o) => o.id);
    const itemCountByOrder = new Map<string, number>();
    if (orderIds.length > 0) {
      const { data: itemRows, error: itemsErr } = await supabase
        .schema("resupply")
        .from("shop_order_items")
        .select("order_id, quantity")
        .in("order_id", orderIds);
      if (itemsErr) throw itemsErr;
      for (const i of itemRows ?? []) {
        itemCountByOrder.set(
          i.order_id,
          (itemCountByOrder.get(i.order_id) ?? 0) + (i.quantity ?? 0),
        );
      }
    }

    // In-app conversation message stats — fetch the messages and
    // compute counts JS-side. The thread is bounded (single thread
    // per customer; admin-only surface).
    const inAppRow = inAppConvRes.data ?? null;
    let inAppStats: {
      messageCount: number;
      unreadFromCustomer: number;
      lastInboundAt: string | null;
      lastOutboundAt: string | null;
    } | null = null;
    if (inAppRow) {
      const { data: msgRows, error: msgErr } = await supabase
        .schema("resupply")
        .from("messages")
        .select("direction, created_at")
        .eq("conversation_id", inAppRow.id);
      if (msgErr) throw msgErr;
      let messageCount = 0;
      let lastInboundAt: string | null = null;
      let lastOutboundAt: string | null = null;
      for (const m of msgRows ?? []) {
        messageCount++;
        if (m.direction === "inbound") {
          if (!lastInboundAt || m.created_at > lastInboundAt) {
            lastInboundAt = m.created_at;
          }
        } else if (m.direction === "outbound") {
          if (!lastOutboundAt || m.created_at > lastOutboundAt) {
            lastOutboundAt = m.created_at;
          }
        }
      }
      // unread = inbound messages strictly after the most-recent
      // outbound (or every inbound when there's no outbound yet).
      const unreadCutoff = lastOutboundAt ?? "";
      let unreadFromCustomer = 0;
      for (const m of msgRows ?? []) {
        if (m.direction === "inbound" && m.created_at > unreadCutoff) {
          unreadFromCustomer++;
        }
      }
      inAppStats = {
        messageCount,
        unreadFromCustomer,
        lastInboundAt,
        lastOutboundAt,
      };
    }

    // Lifetime-stats rollup over EVERY order (not just the recent 25).
    const allOrders = statsOrdersRes.data ?? [];
    let lifetimeValueCents = 0;
    let paidOrdersCount = 0;
    let firstOrderAt: string | null = null;
    let lastOrderAt: string | null = null;
    for (const o of allOrders) {
      if (o.paid_at && o.status !== "refunded") {
        lifetimeValueCents += o.amount_total_cents ?? 0;
        paidOrdersCount += 1;
        if (!firstOrderAt || o.created_at < firstOrderAt) {
          firstOrderAt = o.created_at;
        }
        if (!lastOrderAt || o.created_at > lastOrderAt) {
          lastOrderAt = o.created_at;
        }
      }
    }
    const ordersCount = allOrders.length;
    const pendingReviewsCount = statsPendingReviewsRes.count ?? 0;
    // AOV divides by the orders that CONTRIBUTED to the numerator
    // (paid, non-refunded). Dividing by allOrders.length mixed
    // populations — abandoned/pending checkout rows and refunds
    // dragged the average toward zero.
    const avgOrderValueCents =
      paidOrdersCount > 0
        ? Math.round(lifetimeValueCents / paidOrdersCount)
        : 0;

    // Synthesize a minimal customer object for guest-only userIds.
    const guestSynth = !customerRow && orderRows.length > 0;
    const customer = customerRow
      ? {
          userId: customerRow.customer_id,
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
          clinicalInfo: {
            cpapDevice: customerRow.cpap_device_json ?? null,
            physicianInfo: customerRow.physician_info_json ?? null,
            facialMeasurements: customerRow.facial_measurements_json ?? null,
          },
          createdAt: customerRow.created_at,
          updatedAt: customerRow.updated_at,
          isGuest: false as const,
          linkedPatientId,
        }
      : {
          userId,
          displayName: null,
          email: null,
          stripeCustomerId: null,
          shippingAddress: orderRows[0]?.shipping_address_json ?? null,
          defaultPaymentMethod: null,
          clinicalInfo: {
            cpapDevice: null,
            physicianInfo: null,
            facialMeasurements: null,
          },
          createdAt:
            orderRows[orderRows.length - 1]?.created_at ??
            new Date().toISOString(),
          updatedAt: orderRows[0]?.created_at ?? new Date().toISOString(),
          isGuest: true as const,
          linkedPatientId: null,
        };

    req.log?.info(
      {
        userId,
        ordersCount,
        subscriptionsCount: subsRes.data?.length ?? 0,
        reviewsCount: reviewsRes.data?.length ?? 0,
        hasAbandonedCart: !!cartRes.data,
        guestSynth,
        adminEmail: req.adminEmail,
      },
      "admin.shop.customers.detail",
    );

    const cart = cartRes.data;

    res.json({
      customer,
      orders: orderRows.map((o) => ({
        id: o.id,
        stripeSessionId: o.stripe_session_id,
        stripePaymentIntentId: o.stripe_payment_intent_id,
        status: o.status,
        amountTotalCents: o.amount_total_cents,
        currency: o.currency,
        // PostgREST returns timestamptz as ISO string already.
        createdAt: o.created_at,
        paidAt: o.paid_at,
        shippedAt: o.shipped_at,
        deliveredAt: o.delivered_at,
        trackingCarrier: o.tracking_carrier,
        trackingNumber: o.tracking_number,
        shippingAddress: o.shipping_address_json ?? null,
        itemCount: itemCountByOrder.get(o.id) ?? 0,
      })),
      subscriptions: (subsRes.data ?? []).map((s) => ({
        id: s.id,
        stripeSubscriptionId: s.stripe_subscription_id,
        stripeCustomerId: s.stripe_customer_id,
        status: s.status,
        items: s.items ?? [],
        currentPeriodEnd: s.current_period_end,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        canceledAt: s.canceled_at,
        initialAmountTotalCents: s.initial_amount_total_cents,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      })),
      abandonedCart: cart
        ? {
            id: cart.id,
            items: cart.items ?? [],
            subtotalCents: cart.subtotal_cents,
            currency: cart.currency,
            updatedAt: cart.updated_at,
            remindedAt: cart.reminded_at,
            recoveredAt: cart.recovered_at,
            clearedAt: cart.cleared_at,
            createdAt: cart.created_at,
          }
        : null,
      reviews: (reviewsRes.data ?? []).map((r) => ({
        id: r.id,
        productId: r.product_id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        status: r.status,
        moderationNote: r.moderation_note,
        moderatedAt: r.moderated_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      stats: {
        ordersCount,
        lifetimeValueCents,
        avgOrderValueCents,
        firstOrderAt,
        lastOrderAt,
        pendingReviewsCount,
      },
      inAppConversation:
        inAppRow && inAppStats
          ? {
              id: inAppRow.id,
              status: inAppRow.status,
              messageCount: inAppStats.messageCount,
              unreadFromCustomer: inAppStats.unreadFromCustomer,
              lastMessageAt: inAppRow.last_message_at,
              lastInboundAt: inAppStats.lastInboundAt,
              lastOutboundAt: inAppStats.lastOutboundAt,
              createdAt: inAppRow.created_at,
            }
          : null,
    });
  },
);

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

router.post(
  "/admin/shop/customers/:userId/reorder",
  // CSR-driven reorder on behalf of a customer — creates a new
  // Stripe Checkout Session. `conversations.manage` keeps this in
  // the same operational tier as the rest of customer-360 surface.
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_customers.reorder", preset: "mutation" }),
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

    const supabase = getSupabaseServiceRoleClient();

    // 1. Look up the source order. Must belong to this userId AND
    //    be paid AND not refunded.
    const { data: order, error: orderErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id, status, paid_at, customer_id")
      .eq("id", sourceOrderId)
      .limit(1)
      .maybeSingle();
    if (orderErr) throw orderErr;
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

    // 2. Pull the source order's line items. The original raw SQL
    //    rejected zero-quantity / null-price-id rows; PostgREST has
    //    no `<>` operator on text other than `.neq()`, so we fetch
    //    everything and filter JS-side (line-item count is bounded
    //    per order).
    const { data: rawItems, error: itemsErr } = await supabase
      .schema("resupply")
      .from("shop_order_items")
      .select("price_id, quantity")
      .eq("order_id", sourceOrderId);
    if (itemsErr) throw itemsErr;
    const items = (rawItems ?? []).filter(
      (it): it is { price_id: string; quantity: number } =>
        typeof it.price_id === "string" &&
        it.price_id.length > 0 &&
        typeof it.quantity === "number" &&
        it.quantity > 0,
    );

    if (items.length === 0) {
      res.status(400).json({ error: "source_order_has_no_items" });
      return;
    }

    // 3. Look up the customer mirror to decide between `customer`
    //    (preferred — keeps Stripe analytics linked) and
    //    `customer_email` (fallback for guest-checkout-only ids).
    const { data: customerLookup, error: customerLookupErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("email_lower, stripe_customer_id")
      .eq("customer_id", userId)
      .limit(1)
      .maybeSingle();
    if (customerLookupErr) throw customerLookupErr;

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
          line_items: items.map((it) => ({
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
        lineItemCount: items.length,
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
