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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

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
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

// Financial CSV exports — scoped to `reports.read`. Held by admin /
// supervisor / csr / compliance_officer / agent. Tightens access for
// `fitter` and `fulfillment` (neither has a workflow that requires
// pulling cash-pay finance exports).
router.get("/admin/reports/orders.csv", requirePermission("reports.read"), async (req, res) => {
  const { from, to } = parseRange(req);
  const supabase = getSupabaseServiceRoleClient();
  const { data: orders, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select(
      "id, stripe_session_id, stripe_payment_intent_id, status, amount_total_cents, currency, customer_id, created_at, paid_at, shipped_at, delivered_at, tracking_carrier, tracking_number",
    )
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;

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

  for (const o of orders ?? []) {
    const row = [
      o.id,
      o.stripe_session_id,
      o.stripe_payment_intent_id,
      o.status,
      o.amount_total_cents !== null
        ? (o.amount_total_cents / 100).toFixed(2)
        : "",
      o.currency,
      o.customer_id,
      o.created_at,
      o.paid_at,
      o.shipped_at,
      o.delivered_at,
      o.tracking_carrier,
      o.tracking_number,
    ];
    res.write(row.map(escapeCsv).join(",") + "\n");
  }
  res.end();
});

router.get("/admin/reports/returns.csv", requirePermission("reports.read"), async (req, res) => {
  const { from, to } = parseRange(req);
  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .select("*")
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;

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

  for (const r of rows ?? []) {
    const row = [
      r.id,
      r.order_id,
      r.stripe_session_id,
      r.status,
      r.reason,
      r.resolution,
      r.refund_cents !== null ? (r.refund_cents / 100).toFixed(2) : "",
      r.stripe_refund_id,
      r.exchange_product_id,
      r.created_at,
      r.approved_at,
      r.received_at,
      r.resolved_at,
      r.closed_at,
    ];
    res.write(row.map(escapeCsv).join(",") + "\n");
  }
  res.end();
});

export default router;
