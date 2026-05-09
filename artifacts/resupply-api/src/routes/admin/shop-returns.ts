// /admin/shop/returns — admin-side moderation + processing of customer
// return / RMA requests.
//
// Endpoints (all requireAdmin-gated):
//   GET   /admin/shop/returns?status=&cursor=&limit=  — paginated queue.
//   GET   /admin/shop/returns/:id                     — single return detail.
//   POST  /admin/shop/returns/:id/approve             — issue label window
//                                                       (requested → approved).
//   POST  /admin/shop/returns/:id/reject              — close as rejected.
//   POST  /admin/shop/returns/:id/mark-shipped        — customer dropped at
//                                                       carrier (approved →
//                                                       shipped_back).
//   POST  /admin/shop/returns/:id/mark-received       — parcel landed at
//                                                       warehouse (shipped_back
//                                                       → received).
//   POST  /admin/shop/returns/:id/refund              — issue Stripe Refund;
//                                                       received → refunded.
//   POST  /admin/shop/returns/:id/replace             — record replacement
//                                                       order; received →
//                                                       replaced.
//   POST  /admin/shop/returns/:id/note                — append admin note.
//
// Lifecycle is a strict forward state machine — every transition
// asserts the from-state and 409s on mismatch. This makes
// double-clicks and admin race conditions safe instead of
// silently advancing the workflow twice.
//
// Stripe Refund execution is BEHIND a feature flag (STRIPE_SECRET_KEY
// presence). In preview / test environments without the key the
// /refund endpoint records the resolution metadata but does NOT call
// Stripe — the admin sees the row flip to `refunded` with a
// `stripeRefundId: null` so they know to issue the refund manually.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type ShopReturnStatus,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";
import { withMetrics } from "../../lib/observability";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";

type ShopReturnRow = Database["resupply"]["Tables"]["shop_returns"]["Row"];

const router: IRouter = Router();

// Per-admin rate limits on return-lifecycle mutations (B-07). Two
// buckets keyed by adminUserId:
//   * adminReturnFinancialLimiter — 10/hour. Refund + replace move
//     real money / inventory. Tighter cap to bound a compromised
//     account.
//   * adminReturnLifecycleLimiter — 60/hour. approve/reject/mark-
//     shipped/mark-received are state-machine transitions with no
//     direct money movement, but still deserve a per-actor cap so a
//     scripted abuser can't churn the queue.
const adminReturnFinancialLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "admin_shop_return_financial",
  keyFn: (req) => req.adminUserId ?? "unknown",
});
const adminReturnLifecycleLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: "admin_shop_return_lifecycle",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const STATUS_VALUES: ShopReturnStatus[] = [
  "requested",
  "approved",
  "rejected",
  "shipped_back",
  "received",
  "refunded",
  "replaced",
  "closed",
];
const STATUS_FILTER = new Set<string>([...STATUS_VALUES, "all", "open"]);

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

const RETURN_COLUMNS =
  "id, customer_id, order_id, stripe_session_id, status, reason, reason_note, resolution, refund_cents, stripe_refund_id, exchange_product_id, exchange_price_id, exchange_order_id, return_label_url, return_carrier, return_tracking_number, admin_note, admin_user_id, created_at, updated_at, approved_at, rejected_at, shipped_back_at, received_at, resolved_at, closed_at";

router.get("/admin/shop/returns", requireAdmin, async (req, res) => {
  const status = String(req.query.status ?? "open");
  if (!STATUS_FILTER.has(status)) {
    res.status(400).json({ error: "invalid_status" });
    return;
  }
  const limit = Math.min(
    Math.max(1, Number(req.query.limit ?? PAGE_SIZE_DEFAULT)),
    PAGE_SIZE_MAX,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const supabase = getSupabaseServiceRoleClient();

  // Cursor format: "<ISO timestamp>__<id>" (composite — same pattern as
  // shop-reviews so paginating across rows that share createdAt is
  // stable).
  let cursorTs: Date | null = null;
  let cursorId: string | null = null;
  if (cursor) {
    const idx = cursor.indexOf("__");
    if (idx > 0) {
      cursorTs = new Date(cursor.slice(0, idx));
      cursorId = cursor.slice(idx + 2);
      if (Number.isNaN(cursorTs.getTime())) {
        cursorTs = null;
        cursorId = null;
      }
    }
  }

  let listQuery = supabase
    .schema("resupply")
    .from("shop_returns")
    .select(RETURN_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (status === "open") {
    listQuery = listQuery.in("status", [
      "requested",
      "approved",
      "shipped_back",
      "received",
    ]);
  } else if (status !== "all") {
    listQuery = listQuery.eq("status", status);
  }
  if (cursorTs && cursorId) {
    const cursorIso = cursorTs.toISOString();
    listQuery = listQuery.or(
      `created_at.lt.${cursorIso},and(created_at.eq.${cursorIso},id.lt.${cursorId})`,
    );
  }
  const { data: rows, error } = await listQuery;
  if (error) throw error;

  const all = rows ?? [];
  const hasMore = all.length > limit;
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? `${last.created_at}__${last.id}` : null;

  res.json({
    returns: page.map(serializeReturnRow),
    nextCursor,
  });
});

router.get("/admin/shop/returns/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .select(RETURN_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    res.status(404).json({ error: "return_not_found" });
    return;
  }
  res.json({ return: serializeReturnRow(row) });
});

const approveBody = z
  .object({
    note: z.string().trim().max(2000).optional().nullable(),
    returnLabelUrl: z.string().url().optional().nullable(),
    returnCarrier: z.string().trim().max(40).optional().nullable(),
    returnTrackingNumber: z.string().trim().max(100).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/returns/:id/approve",
  requireAdmin,
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = approveBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "approved",
        approved_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Approved"),
        return_label_url: parsed.data.returnLabelUrl ?? null,
        return_carrier: parsed.data.returnCarrier ?? null,
        return_tracking_number: parsed.data.returnTrackingNumber ?? null,
      })
      .eq("id", id)
      .eq("status", "requested")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_requested_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

const noteOnly = z
  .object({ note: z.string().trim().max(2000).optional().nullable() })
  .strict();

router.post(
  "/admin/shop/returns/:id/reject",
  requireAdmin,
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = noteOnly.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "rejected",
        rejected_at: nowIso,
        closed_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Rejected"),
      })
      .eq("id", id)
      .eq("status", "requested")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_requested_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

router.post(
  "/admin/shop/returns/:id/mark-shipped",
  requireAdmin,
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = noteOnly.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "shipped_back",
        shipped_back_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Marked shipped back"),
      })
      .eq("id", id)
      .eq("status", "approved")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_approved_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

router.post(
  "/admin/shop/returns/:id/mark-received",
  requireAdmin,
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = noteOnly.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    // Allow received from either shipped_back (normal flow) or
    // approved (admin received before flipping shipped_back —
    // happens when ops scans the inbound parcel without first
    // marking it dispatched).
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "received",
        received_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Marked received"),
      })
      .eq("id", id)
      .in("status", ["shipped_back", "approved"])
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_shipped_or_approved_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

const refundBody = z
  .object({
    amountCents: z.number().int().positive().optional(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/returns/:id/refund",
  requireAdmin,
  adminReturnFinancialLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = refundBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: ret, error: lookupErr } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .select(RETURN_COLUMNS)
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!ret) {
      res.status(404).json({ error: "return_not_found" });
      return;
    }
    if (ret.status !== "received") {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }

    // Look up the order to grab the payment intent ID for Stripe.
    const { data: orderRow, error: orderErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("stripe_payment_intent_id, amount_total_cents")
      .eq("id", ret.order_id)
      .limit(1)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!orderRow) {
      res.status(409).json({ error: "order_not_found" });
      return;
    }

    const refundCents =
      parsed.data.amountCents ?? orderRow.amount_total_cents ?? 0;
    if (!refundCents || refundCents <= 0) {
      res.status(400).json({ error: "missing_refund_amount" });
      return;
    }

    let stripeRefundId: string | null = null;
    const stripeConfig = readStripeConfigOrNull(process.env);
    const stripe = stripeConfig ? getStripeClient(stripeConfig) : null;
    if (stripe && orderRow.stripe_payment_intent_id) {
      try {
        // Per-return + per-amount idempotency key. Two admins clicking
        // "Refund" on the same return for the same amount collapse to a
        // single Stripe Refund object. Different partial-refund amounts
        // on the same return each create a separate Refund — that's
        // intentional (partial refunds may legitimately stack). Mirrors
        // the shop_orders refund pattern (sprint 5, e98a0bf).
        const idempotencyKey = `shop-return-refund-${ret.id}-${refundCents}`;
        // Capture the narrowed string into a const so the arrow-fn
        // callback below keeps the TS control-flow narrowing from the
        // outer `if (stripe && orderRow.stripe_payment_intent_id)`.
        const paymentIntentId = orderRow.stripe_payment_intent_id;
        const refund = await withMetrics(
          {
            name: "stripe.refunds.create",
            attrs: { surface: "admin_shop_return" },
          },
          () =>
            stripe.refunds.create(
              {
                payment_intent: paymentIntentId,
                amount: refundCents,
                reason: "requested_by_customer",
                metadata: {
                  shop_return_id: ret.id,
                  shop_order_id: ret.order_id,
                },
              },
              { idempotencyKey },
            ),
        );
        stripeRefundId = refund.id;
      } catch (err) {
        // Don't block the workflow on a Stripe-side error — log it and
        // let the admin retry. We keep status at `received` so the
        // operator can re-issue.
        const refundError = err instanceof Error ? err.message : String(err);
        req.log?.warn(
          { returnId: ret.id, err: refundError },
          "stripe refund failed",
        );
        res.status(502).json({
          error: "stripe_refund_failed",
          message: refundError,
        });
        return;
      }
    }

    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "refunded",
        resolution: "refund",
        resolved_at: nowIso,
        closed_at: nowIso,
        updated_at: nowIso,
        refund_cents: refundCents,
        stripe_refund_id: stripeRefundId,
        admin_user_id: adminId,
        admin_note: appendNote(
          parsed.data.note,
          adminId,
          stripeRefundId
            ? `Refunded ${formatCents(refundCents)} via Stripe (${stripeRefundId})`
            : `Refund of ${formatCents(refundCents)} recorded; issue manually in Stripe (no SDK key configured).`,
        ),
      })
      .eq("id", ret.id)
      .eq("status", "received")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

const replaceBody = z
  .object({
    // Stripe product/price/order ids are short fixed-format strings
    // (`prod_<...>`, `price_<...>`, etc., 14-30 chars). Cap at 100 to
    // match the project-wide convention of bounding every Zod string
    // that lands in the DB.
    exchangeProductId: z.string().min(1).max(100),
    exchangePriceId: z.string().min(1).max(100),
    exchangeOrderId: z.string().min(1).max(100).optional().nullable(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/returns/:id/replace",
  requireAdmin,
  adminReturnFinancialLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = replaceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "replaced",
        resolution: "exchange",
        resolved_at: nowIso,
        closed_at: nowIso,
        updated_at: nowIso,
        exchange_product_id: parsed.data.exchangeProductId,
        exchange_price_id: parsed.data.exchangePriceId,
        exchange_order_id: parsed.data.exchangeOrderId ?? null,
        admin_user_id: adminId,
        admin_note: appendNote(
          parsed.data.note,
          adminId,
          `Replacement issued (${parsed.data.exchangeProductId})`,
        ),
      })
      .eq("id", id)
      .eq("status", "received")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

router.post("/admin/shop/returns/:id/note", requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const parsed = noteOnly.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.note) {
    res.status(400).json({ error: "missing_note" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const adminId = req.adminUserId ?? null;
  const { data: ret, error: lookupErr } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .select(RETURN_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!ret) {
    res.status(404).json({ error: "return_not_found" });
    return;
  }
  const { data: updated, error: updateErr } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .update({
      admin_note: appendNote(
        parsed.data.note,
        adminId,
        "Note added",
        ret.admin_note,
      ),
      admin_user_id: adminId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(RETURN_COLUMNS)
    .limit(1)
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!updated) {
    res.status(404).json({ error: "return_not_found" });
    return;
  }
  res.json({ return: serializeReturnRow(updated) });
});

function appendNote(
  newText: string | null | undefined,
  adminId: string | null,
  action: string,
  prior?: string | null,
): string {
  // Newest-first concatenation; capped at 8KB to bound the column.
  const stamp = new Date().toISOString();
  const head = `[${stamp}] ${adminId ?? "admin"} — ${action}${
    newText ? `: ${newText}` : ""
  }`;
  const combined = prior ? `${head}\n\n${prior}` : head;
  return combined.length > 8000 ? combined.slice(0, 8000) : combined;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function serializeReturnRow(r: ShopReturnRow) {
  return {
    id: r.id,
    customerId: r.customer_id,
    orderId: r.order_id,
    sessionId: r.stripe_session_id,
    status: r.status,
    reason: r.reason,
    reasonNote: r.reason_note,
    resolution: r.resolution,
    refundCents: r.refund_cents,
    stripeRefundId: r.stripe_refund_id,
    exchangeProductId: r.exchange_product_id,
    exchangePriceId: r.exchange_price_id,
    exchangeOrderId: r.exchange_order_id,
    returnLabelUrl: r.return_label_url,
    returnCarrier: r.return_carrier,
    returnTrackingNumber: r.return_tracking_number,
    adminNote: r.admin_note,
    adminUserId: r.admin_user_id,
    // PostgREST returns timestamptz as ISO string already.
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at,
    rejectedAt: r.rejected_at,
    shippedBackAt: r.shipped_back_at,
    receivedAt: r.received_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
  };
}

export default router;
