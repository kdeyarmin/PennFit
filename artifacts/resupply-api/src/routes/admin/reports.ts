// /admin/reports/* — CSV downloads for ops + finance.
//
//   GET /admin/reports/orders.csv   ?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /admin/reports/returns.csv  ?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Date range defaults to the last 30 days. Cap at 90 days per export
// to keep response times bounded — operators who need wider ranges
// can chunk.
//
// All endpoints stream a Content-Type: text/csv response with a
// reasonable Content-Disposition filename so the browser saves
// directly. No PHI on either path — orders are cash-pay, returns
// reference cash-pay orders.

import { Router, type IRouter } from "express";
import { and, gte, lte, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  shopOrders,
  shopReturns,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

function parseRange(req: import("express").Request): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  const toRaw = typeof req.query.to === "string" ? req.query.to : null;
  const fromRaw = typeof req.query.from === "string" ? req.query.from : null;
  const to = toRaw ? new Date(toRaw + "T23:59:59Z") : now;
  const from = fromRaw
    ? new Date(fromRaw + "T00:00:00Z")
    : new Date(now.getTime() - DEFAULT_DAYS * 86400_000);
  // Clamp range
  const days = (to.getTime() - from.getTime()) / 86400_000;
  if (days > MAX_DAYS) {
    return {
      from: new Date(to.getTime() - MAX_DAYS * 86400_000),
      to,
    };
  }
  return { from, to };
}

function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function setCsvHeaders(res: import("express").Response, filename: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
}

router.get("/admin/reports/orders.csv", requireAdmin, async (req, res) => {
  const { from, to } = parseRange(req);
  const db = drizzle(getDbPool());
  const orders = await db
    .select({
      id: shopOrders.id,
      sessionId: shopOrders.stripeSessionId,
      paymentIntentId: shopOrders.stripePaymentIntentId,
      status: shopOrders.status,
      amountTotalCents: shopOrders.amountTotalCents,
      currency: shopOrders.currency,
      customerId: shopOrders.customerId,
      createdAt: shopOrders.createdAt,
      paidAt: shopOrders.paidAt,
      shippedAt: shopOrders.shippedAt,
      deliveredAt: shopOrders.deliveredAt,
      trackingCarrier: shopOrders.trackingCarrier,
      trackingNumber: shopOrders.trackingNumber,
    })
    .from(shopOrders)
    .where(
      and(
        gte(shopOrders.createdAt, from),
        lte(shopOrders.createdAt, to),
      ),
    )
    .orderBy(desc(shopOrders.createdAt));

  // Line-item joining is intentionally not in the orders CSV — the
  // returns CSV below carries it via shop_returns.exchangeProductId.
  // Operators wanting per-line breakdowns hit the per-order detail
  // route instead.

  setCsvHeaders(
    res,
    `pennpaps-orders-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`,
  );

  const headers = [
    "order_id",
    "stripe_session_id",
    "stripe_payment_intent_id",
    "status",
    "total_usd",
    "currency",
    "customer_id",
    "created_at",
    "paid_at",
    "shipped_at",
    "delivered_at",
    "tracking_carrier",
    "tracking_number",
  ];
  res.write(headers.join(",") + "\n");

  for (const o of orders) {
    const row = [
      o.id,
      o.sessionId,
      o.paymentIntentId,
      o.status,
      o.amountTotalCents !== null ? (o.amountTotalCents / 100).toFixed(2) : "",
      o.currency,
      o.customerId,
      o.createdAt.toISOString(),
      o.paidAt?.toISOString(),
      o.shippedAt?.toISOString(),
      o.deliveredAt?.toISOString(),
      o.trackingCarrier,
      o.trackingNumber,
    ];
    res.write(row.map(escapeCsv).join(",") + "\n");
  }
  res.end();
});

router.get("/admin/reports/returns.csv", requireAdmin, async (req, res) => {
  const { from, to } = parseRange(req);
  const db = drizzle(getDbPool());
  const rows = await db
    .select()
    .from(shopReturns)
    .where(
      and(
        gte(shopReturns.createdAt, from),
        lte(shopReturns.createdAt, to),
      ),
    )
    .orderBy(desc(shopReturns.createdAt));

  setCsvHeaders(
    res,
    `pennpaps-returns-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`,
  );

  const headers = [
    "return_id",
    "order_id",
    "stripe_session_id",
    "status",
    "reason",
    "resolution",
    "refund_usd",
    "stripe_refund_id",
    "exchange_product_id",
    "created_at",
    "approved_at",
    "received_at",
    "resolved_at",
    "closed_at",
  ];
  res.write(headers.join(",") + "\n");

  for (const r of rows) {
    const row = [
      r.id,
      r.orderId,
      r.stripeSessionId,
      r.status,
      r.reason,
      r.resolution,
      r.refundCents !== null ? (r.refundCents / 100).toFixed(2) : "",
      r.stripeRefundId,
      r.exchangeProductId,
      r.createdAt.toISOString(),
      r.approvedAt?.toISOString(),
      r.receivedAt?.toISOString(),
      r.resolvedAt?.toISOString(),
      r.closedAt?.toISOString(),
    ];
    res.write(row.map(escapeCsv).join(",") + "\n");
  }
  res.end();
});

export default router;
