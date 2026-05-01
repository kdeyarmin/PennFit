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
import { and, eq, desc, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  getDbPool,
  shopReturns,
  type ShopReturnStatus,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";

const router: IRouter = Router();

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

  const db = drizzle(getDbPool());

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

  const conds = [];
  if (status === "open") {
    conds.push(
      sql`${shopReturns.status} IN ('requested','approved','shipped_back','received')`,
    );
  } else if (status !== "all") {
    conds.push(eq(shopReturns.status, status as ShopReturnStatus));
  }
  if (cursorTs && cursorId) {
    conds.push(
      or(
        lt(shopReturns.createdAt, cursorTs),
        and(eq(shopReturns.createdAt, cursorTs), lt(shopReturns.id, cursorId)),
      ),
    );
  }

  const rows = await db
    .select()
    .from(shopReturns)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(shopReturns.createdAt), desc(shopReturns.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? `${last.createdAt.toISOString()}__${last.id}`
      : null;

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
  const db = drizzle(getDbPool());
  const rows = await db
    .select()
    .from(shopReturns)
    .where(eq(shopReturns.id, id))
    .limit(1);
  const row = rows[0];
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
    const db = drizzle(getDbPool());
    const adminId = req.adminUserId ?? null;
    const now = new Date();
    const updated = await db
      .update(shopReturns)
      .set({
        status: "approved",
        approvedAt: now,
        updatedAt: now,
        adminClerkId: adminId,
        adminNote: appendNote(req.body?.note, adminId, "Approved"),
        returnLabelUrl: parsed.data.returnLabelUrl ?? null,
        returnCarrier: parsed.data.returnCarrier ?? null,
        returnTrackingNumber: parsed.data.returnTrackingNumber ?? null,
      })
      .where(and(eq(shopReturns.id, id), eq(shopReturns.status, "requested")))
      .returning();
    if (updated.length === 0) {
      res.status(409).json({ error: "not_in_requested_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated[0]!) });
  },
);

const noteOnly = z
  .object({ note: z.string().trim().max(2000).optional().nullable() })
  .strict();

router.post(
  "/admin/shop/returns/:id/reject",
  requireAdmin,
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
    const db = drizzle(getDbPool());
    const adminId = req.adminUserId ?? null;
    const now = new Date();
    const updated = await db
      .update(shopReturns)
      .set({
        status: "rejected",
        rejectedAt: now,
        closedAt: now,
        updatedAt: now,
        adminClerkId: adminId,
        adminNote: appendNote(parsed.data.note, adminId, "Rejected"),
      })
      .where(and(eq(shopReturns.id, id), eq(shopReturns.status, "requested")))
      .returning();
    if (updated.length === 0) {
      res.status(409).json({ error: "not_in_requested_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated[0]!) });
  },
);

router.post(
  "/admin/shop/returns/:id/mark-shipped",
  requireAdmin,
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
    const db = drizzle(getDbPool());
    const adminId = req.adminUserId ?? null;
    const now = new Date();
    const updated = await db
      .update(shopReturns)
      .set({
        status: "shipped_back",
        shippedBackAt: now,
        updatedAt: now,
        adminClerkId: adminId,
        adminNote: appendNote(parsed.data.note, adminId, "Marked shipped back"),
      })
      .where(and(eq(shopReturns.id, id), eq(shopReturns.status, "approved")))
      .returning();
    if (updated.length === 0) {
      res.status(409).json({ error: "not_in_approved_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated[0]!) });
  },
);

router.post(
  "/admin/shop/returns/:id/mark-received",
  requireAdmin,
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
    const db = drizzle(getDbPool());
    const adminId = req.adminUserId ?? null;
    const now = new Date();
    // Allow received from either shipped_back (normal flow) or
    // approved (admin received before flipping shipped_back —
    // happens when ops scans the inbound parcel without first
    // marking it dispatched).
    const updated = await db
      .update(shopReturns)
      .set({
        status: "received",
        receivedAt: now,
        updatedAt: now,
        adminClerkId: adminId,
        adminNote: appendNote(parsed.data.note, adminId, "Marked received"),
      })
      .where(
        and(
          eq(shopReturns.id, id),
          or(
            eq(shopReturns.status, "shipped_back"),
            eq(shopReturns.status, "approved"),
          ),
        ),
      )
      .returning();
    if (updated.length === 0) {
      res.status(409).json({ error: "not_in_shipped_or_approved_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated[0]!) });
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

    const db = drizzle(getDbPool());
    const rows = await db
      .select()
      .from(shopReturns)
      .where(eq(shopReturns.id, id))
      .limit(1);
    const ret = rows[0];
    if (!ret) {
      res.status(404).json({ error: "return_not_found" });
      return;
    }
    if (ret.status !== "received") {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }

    // Look up the order to grab the payment intent ID for Stripe.
    const ordersRows = await db.execute<{
      stripe_payment_intent_id: string | null;
      amount_total_cents: number | null;
    }>(
      sql`select stripe_payment_intent_id, amount_total_cents from resupply.shop_orders where id = ${ret.orderId} limit 1`,
    );
    const orderRow = ordersRows.rows[0];
    if (!orderRow) {
      res.status(409).json({ error: "order_not_found" });
      return;
    }

    const refundCents = parsed.data.amountCents ?? orderRow.amount_total_cents;
    if (!refundCents || refundCents <= 0) {
      res.status(400).json({ error: "missing_refund_amount" });
      return;
    }

    let stripeRefundId: string | null = null;
    const stripeConfig = readStripeConfigOrNull(process.env);
    const stripe = stripeConfig ? getStripeClient(stripeConfig) : null;
    if (stripe && orderRow.stripe_payment_intent_id) {
      try {
        const refund = await stripe.refunds.create({
          payment_intent: orderRow.stripe_payment_intent_id,
          amount: refundCents,
          reason: "requested_by_customer",
          metadata: {
            shop_return_id: ret.id,
            shop_order_id: ret.orderId,
          },
        });
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
    const now = new Date();
    const updated = await db
      .update(shopReturns)
      .set({
        status: "refunded",
        resolution: "refund",
        resolvedAt: now,
        closedAt: now,
        updatedAt: now,
        refundCents,
        stripeRefundId,
        adminClerkId: adminId,
        adminNote: appendNote(
          parsed.data.note,
          adminId,
          stripeRefundId
            ? `Refunded ${formatCents(refundCents)} via Stripe (${stripeRefundId})`
            : `Refund of ${formatCents(refundCents)} recorded; issue manually in Stripe (no SDK key configured).`,
        ),
      })
      .where(eq(shopReturns.id, ret.id))
      .returning();
    res.json({ return: serializeReturnRow(updated[0]!) });
  },
);

const replaceBody = z
  .object({
    exchangeProductId: z.string().min(1),
    exchangePriceId: z.string().min(1),
    exchangeOrderId: z.string().min(1).optional().nullable(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/returns/:id/replace",
  requireAdmin,
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
    const db = drizzle(getDbPool());
    const adminId = req.adminUserId ?? null;
    const now = new Date();
    const updated = await db
      .update(shopReturns)
      .set({
        status: "replaced",
        resolution: "exchange",
        resolvedAt: now,
        closedAt: now,
        updatedAt: now,
        exchangeProductId: parsed.data.exchangeProductId,
        exchangePriceId: parsed.data.exchangePriceId,
        exchangeOrderId: parsed.data.exchangeOrderId ?? null,
        adminClerkId: adminId,
        adminNote: appendNote(
          parsed.data.note,
          adminId,
          `Replacement issued (${parsed.data.exchangeProductId})`,
        ),
      })
      .where(and(eq(shopReturns.id, id), eq(shopReturns.status, "received")))
      .returning();
    if (updated.length === 0) {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated[0]!) });
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
  const db = drizzle(getDbPool());
  const adminId = req.adminUserId ?? null;
  const rows = await db
    .select()
    .from(shopReturns)
    .where(eq(shopReturns.id, id))
    .limit(1);
  const ret = rows[0];
  if (!ret) {
    res.status(404).json({ error: "return_not_found" });
    return;
  }
  const updated = await db
    .update(shopReturns)
    .set({
      adminNote: appendNote(parsed.data.note, adminId, "Note added", ret.adminNote),
      adminClerkId: adminId,
      updatedAt: new Date(),
    })
    .where(eq(shopReturns.id, id))
    .returning();
  res.json({ return: serializeReturnRow(updated[0]!) });
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

function serializeReturnRow(r: typeof shopReturns.$inferSelect) {
  return {
    id: r.id,
    clerkUserId: r.clerkUserId,
    orderId: r.orderId,
    sessionId: r.stripeSessionId,
    status: r.status,
    reason: r.reason,
    reasonNote: r.reasonNote,
    resolution: r.resolution,
    refundCents: r.refundCents,
    stripeRefundId: r.stripeRefundId,
    exchangeProductId: r.exchangeProductId,
    exchangePriceId: r.exchangePriceId,
    exchangeOrderId: r.exchangeOrderId,
    returnLabelUrl: r.returnLabelUrl,
    returnCarrier: r.returnCarrier,
    returnTrackingNumber: r.returnTrackingNumber,
    adminNote: r.adminNote,
    adminClerkId: r.adminClerkId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    rejectedAt: r.rejectedAt?.toISOString() ?? null,
    shippedBackAt: r.shippedBackAt?.toISOString() ?? null,
    receivedAt: r.receivedAt?.toISOString() ?? null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
  };
}

export default router;
