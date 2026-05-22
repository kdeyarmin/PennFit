// /admin/reports/* — admin reporting surface.
//
// Each report exposes four download formats:
//   GET /admin/reports/<name>.csv           — operational CSV
//   GET /admin/reports/<name>.pdf           — printable PDF
//   GET /admin/reports/<name>.iif           — QuickBooks Desktop IIF
//   GET /admin/reports/<name>.qbo.csv       — QuickBooks Online CSV
//
// Reports:
//   orders            — Stripe checkout sessions in range
//   returns           — Comfort-guarantee returns / RMAs in range
//   revenue-summary   — per-day revenue + refund + net rollup
//   refunds-journal   — chronological refund ledger
//
// All endpoints require the `reports.read` permission. Date range
// defaults to the last 30 days; max 90 days per export to keep
// response time bounded. None of the four reports surface PHI — the
// storefront is cash-pay only and customer identifiers in the export
// are hashed prefixes from `customerKeyForId`.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  customerKeyForId,
  renderIif,
  renderQboCsv,
  type QuickbooksRowInput,
} from "../../lib/quickbooks-export";
import { renderTablePdf } from "../../lib/report-pdf";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

const PRACTICE_NAME = process.env.RESUPPLY_PRACTICE_NAME ?? "PennPaps";

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
  const days = (to.getTime() - from.getTime()) / 86400_000;
  if (days > MAX_DAYS) {
    return {
      from: new Date(to.getTime() - MAX_DAYS * 86400_000),
      to,
    };
  }
  return { from, to };
}

function rangeLabel(from: Date, to: Date): string {
  return `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`;
}

function rangeSlug(from: Date, to: Date): string {
  return `${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}`;
}

function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function setDownloadHeaders(
  res: import("express").Response,
  contentType: string,
  filename: string,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

function centsToDollars(cents: number | null | undefined): number {
  return cents == null ? 0 : cents / 100;
}

// ─────────────────────────────────────────────────────────────────
// Data fetchers — shared between the format-specific handlers.
// ─────────────────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  status: string | null;
  amount_total_cents: number | null;
  currency: string | null;
  customer_id: string | null;
  created_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  tracking_carrier: string | null;
  tracking_number: string | null;
}

async function fetchOrders(from: Date, to: Date): Promise<OrderRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select(
      "id, stripe_session_id, stripe_payment_intent_id, status, amount_total_cents, currency, customer_id, created_at, paid_at, shipped_at, delivered_at, tracking_carrier, tracking_number",
    )
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as OrderRow[];
}

interface ReturnRow {
  id: string;
  order_id: string | null;
  stripe_session_id: string | null;
  status: string | null;
  reason: string | null;
  resolution: string | null;
  refund_cents: number | null;
  stripe_refund_id: string | null;
  exchange_product_id: string | null;
  created_at: string;
  approved_at: string | null;
  received_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
}

async function fetchReturns(from: Date, to: Date): Promise<ReturnRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .select("*")
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ReturnRow[];
}

// Aggregated revenue + refund rollup, one row per calendar day.
interface RevenueByDay {
  day: string;
  ordersCount: number;
  grossUsd: number;
  refundedUsd: number;
  netUsd: number;
}

function rollupRevenue(
  orders: OrderRow[],
  returns: ReturnRow[],
): RevenueByDay[] {
  const byDay = new Map<
    string,
    { ordersCount: number; grossUsd: number; refundedUsd: number }
  >();
  function bucket(day: string) {
    let v = byDay.get(day);
    if (!v) {
      v = { ordersCount: 0, grossUsd: 0, refundedUsd: 0 };
      byDay.set(day, v);
    }
    return v;
  }
  for (const o of orders) {
    if (o.status !== "paid" && o.status !== "shipped" && o.status !== "delivered") {
      continue;
    }
    const day = (o.paid_at ?? o.created_at).slice(0, 10);
    const b = bucket(day);
    b.ordersCount += 1;
    b.grossUsd += centsToDollars(o.amount_total_cents);
  }
  for (const r of returns) {
    if (r.refund_cents == null || r.refund_cents === 0) continue;
    const day = (r.resolved_at ?? r.approved_at ?? r.created_at).slice(0, 10);
    const b = bucket(day);
    b.refundedUsd += centsToDollars(r.refund_cents);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, v]) => ({
      day,
      ordersCount: v.ordersCount,
      grossUsd: v.grossUsd,
      refundedUsd: v.refundedUsd,
      netUsd: v.grossUsd - v.refundedUsd,
    }));
}

// ─────────────────────────────────────────────────────────────────
// CSV writers
// ─────────────────────────────────────────────────────────────────

function writeOrdersCsv(res: import("express").Response, orders: OrderRow[]): void {
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
}

function writeReturnsCsv(
  res: import("express").Response,
  rows: ReturnRow[],
): void {
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
}

function writeRevenueCsv(
  res: import("express").Response,
  rows: RevenueByDay[],
): void {
  const headers = [
    "day",
    "orders_count",
    "gross_usd",
    "refunded_usd",
    "net_usd",
  ];
  res.write(headers.join(",") + "\n");
  for (const r of rows) {
    res.write(
      [
        r.day,
        r.ordersCount,
        r.grossUsd.toFixed(2),
        r.refundedUsd.toFixed(2),
        r.netUsd.toFixed(2),
      ]
        .map(escapeCsv)
        .join(",") + "\n",
    );
  }
  res.end();
}

function writeRefundsCsv(
  res: import("express").Response,
  rows: ReturnRow[],
): void {
  const headers = [
    "return_id",
    "order_id",
    "stripe_refund_id",
    "refund_usd",
    "reason",
    "approved_at",
    "resolved_at",
  ];
  res.write(headers.join(",") + "\n");
  const refundsOnly = rows.filter(
    (r) => r.refund_cents != null && r.refund_cents > 0,
  );
  for (const r of refundsOnly) {
    res.write(
      [
        r.id,
        r.order_id,
        r.stripe_refund_id,
        (r.refund_cents! / 100).toFixed(2),
        r.reason,
        r.approved_at,
        r.resolved_at,
      ]
        .map(escapeCsv)
        .join(",") + "\n",
    );
  }
  res.end();
}

// ─────────────────────────────────────────────────────────────────
// QuickBooks payload builders — shared by .iif and .qbo.csv.
// ─────────────────────────────────────────────────────────────────

function buildQbRowsFromOrders(orders: OrderRow[]): QuickbooksRowInput[] {
  return orders
    .filter(
      (o) =>
        o.amount_total_cents != null &&
        (o.status === "paid" ||
          o.status === "shipped" ||
          o.status === "delivered"),
    )
    .map((o) => ({
      txnId: `ORD-${o.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`,
      date: (o.paid_at ?? o.created_at).slice(0, 10),
      amountUsd: centsToDollars(o.amount_total_cents),
      kind: "ORDER" as const,
      memo: o.stripe_session_id ?? o.id,
      customerKey: customerKeyForId(o.customer_id),
    }));
}

function buildQbRowsFromReturns(rows: ReturnRow[]): QuickbooksRowInput[] {
  return rows
    .filter((r) => r.refund_cents != null && r.refund_cents > 0)
    .map((r) => ({
      txnId: `RFD-${r.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`,
      date: (r.resolved_at ?? r.approved_at ?? r.created_at).slice(0, 10),
      // Refunds are emitted as NEGATIVE amounts in IIF — the
      // generator handles the sign convention (TRNS-vs-SPL flip)
      // and QBO CSV restores the absolute value alongside the
      // "Credit Memo" type column.
      amountUsd: -centsToDollars(r.refund_cents),
      kind: "REFUND" as const,
      memo: r.stripe_refund_id ?? r.order_id ?? r.id,
      customerKey: customerKeyForId(r.order_id),
    }));
}

// ─────────────────────────────────────────────────────────────────
// ORDERS — CSV / PDF / IIF / QBO CSV
// ─────────────────────────────────────────────────────────────────

router.get(
  "/admin/reports/orders.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const orders = await fetchOrders(from, to);
    setDownloadHeaders(
      res,
      "text/csv; charset=utf-8",
      `pennpaps-orders-${rangeSlug(from, to)}.csv`,
    );
    writeOrdersCsv(res, orders);
  },
);

router.get(
  "/admin/reports/orders.pdf",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const orders = await fetchOrders(from, to);
    const totalUsd = orders.reduce(
      (s, o) => s + centsToDollars(o.amount_total_cents),
      0,
    );
    const pdf = await renderTablePdf({
      title: "Cash-pay orders",
      range: rangeLabel(from, to),
      practiceName: PRACTICE_NAME,
      columns: [
        { label: "Order #", width: 110 },
        { label: "Date", width: 70 },
        { label: "Status", width: 80 },
        { label: "Total (USD)", width: 80, rightAlign: true },
        { label: "Customer", width: 90 },
        { label: "Shipped", width: 70 },
        { label: "Tracking", width: 220 },
      ],
      rows: orders.map((o) => [
        o.id.slice(0, 8),
        o.created_at.slice(0, 10),
        o.status ?? "",
        o.amount_total_cents !== null
          ? (o.amount_total_cents / 100).toFixed(2)
          : "",
        customerKeyForId(o.customer_id),
        o.shipped_at?.slice(0, 10) ?? "",
        [o.tracking_carrier, o.tracking_number].filter(Boolean).join(" "),
      ]),
      summaryLines: [
        `Total orders in range: ${orders.length}`,
        `Gross revenue (all statuses): $${totalUsd.toFixed(2)}`,
      ],
    });
    setDownloadHeaders(
      res,
      "application/pdf",
      `pennpaps-orders-${rangeSlug(from, to)}.pdf`,
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  },
);

router.get(
  "/admin/reports/orders.iif",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const orders = await fetchOrders(from, to);
    const iif = renderIif({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      practiceName: PRACTICE_NAME,
      rows: buildQbRowsFromOrders(orders),
    });
    setDownloadHeaders(
      res,
      "application/octet-stream",
      `pennpaps-orders-${rangeSlug(from, to)}.iif`,
    );
    res.end(iif);
  },
);

router.get(
  "/admin/reports/orders.qbo.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const orders = await fetchOrders(from, to);
    const csv = renderQboCsv({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      practiceName: PRACTICE_NAME,
      rows: buildQbRowsFromOrders(orders),
    });
    setDownloadHeaders(
      res,
      "text/csv; charset=utf-8",
      `pennpaps-orders-qbo-${rangeSlug(from, to)}.csv`,
    );
    res.end(csv);
  },
);

// ─────────────────────────────────────────────────────────────────
// RETURNS — CSV / PDF / IIF / QBO CSV
// ─────────────────────────────────────────────────────────────────

router.get(
  "/admin/reports/returns.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const rows = await fetchReturns(from, to);
    setDownloadHeaders(
      res,
      "text/csv; charset=utf-8",
      `pennpaps-returns-${rangeSlug(from, to)}.csv`,
    );
    writeReturnsCsv(res, rows);
  },
);

router.get(
  "/admin/reports/returns.pdf",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const rows = await fetchReturns(from, to);
    const refundTotal = rows.reduce(
      (s, r) => s + centsToDollars(r.refund_cents),
      0,
    );
    const pdf = await renderTablePdf({
      title: "Returns & RMAs",
      range: rangeLabel(from, to),
      practiceName: PRACTICE_NAME,
      columns: [
        { label: "Return #", width: 90 },
        { label: "Order #", width: 90 },
        { label: "Status", width: 80 },
        { label: "Reason", width: 130 },
        { label: "Resolution", width: 100 },
        { label: "Refund (USD)", width: 90, rightAlign: true },
        { label: "Created", width: 80 },
        { label: "Resolved", width: 80 },
      ],
      rows: rows.map((r) => [
        r.id.slice(0, 8),
        r.order_id?.slice(0, 8) ?? "",
        r.status ?? "",
        r.reason ?? "",
        r.resolution ?? "",
        r.refund_cents !== null ? (r.refund_cents / 100).toFixed(2) : "",
        r.created_at.slice(0, 10),
        r.resolved_at?.slice(0, 10) ?? "",
      ]),
      summaryLines: [
        `Total returns in range: ${rows.length}`,
        `Total refunded: $${refundTotal.toFixed(2)}`,
      ],
    });
    setDownloadHeaders(
      res,
      "application/pdf",
      `pennpaps-returns-${rangeSlug(from, to)}.pdf`,
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  },
);

router.get(
  "/admin/reports/returns.iif",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const rows = await fetchReturns(from, to);
    const iif = renderIif({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      practiceName: PRACTICE_NAME,
      rows: buildQbRowsFromReturns(rows),
    });
    setDownloadHeaders(
      res,
      "application/octet-stream",
      `pennpaps-returns-${rangeSlug(from, to)}.iif`,
    );
    res.end(iif);
  },
);

router.get(
  "/admin/reports/returns.qbo.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const rows = await fetchReturns(from, to);
    const csv = renderQboCsv({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      practiceName: PRACTICE_NAME,
      rows: buildQbRowsFromReturns(rows),
    });
    setDownloadHeaders(
      res,
      "text/csv; charset=utf-8",
      `pennpaps-returns-qbo-${rangeSlug(from, to)}.csv`,
    );
    res.end(csv);
  },
);

// ─────────────────────────────────────────────────────────────────
// REVENUE SUMMARY — per-day rollup. CSV + PDF + (IIF / QBO reuse
// the underlying orders rows, so the combined export lives on the
// orders endpoints — we don't double-emit the same transactions in
// the revenue download).
// ─────────────────────────────────────────────────────────────────

router.get(
  "/admin/reports/revenue-summary.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const [orders, returns] = await Promise.all([
      fetchOrders(from, to),
      fetchReturns(from, to),
    ]);
    setDownloadHeaders(
      res,
      "text/csv; charset=utf-8",
      `pennpaps-revenue-${rangeSlug(from, to)}.csv`,
    );
    writeRevenueCsv(res, rollupRevenue(orders, returns));
  },
);

router.get(
  "/admin/reports/revenue-summary.pdf",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const [orders, returns] = await Promise.all([
      fetchOrders(from, to),
      fetchReturns(from, to),
    ]);
    const rows = rollupRevenue(orders, returns);
    const totals = rows.reduce(
      (acc, r) => ({
        gross: acc.gross + r.grossUsd,
        refunded: acc.refunded + r.refundedUsd,
        net: acc.net + r.netUsd,
        orders: acc.orders + r.ordersCount,
      }),
      { gross: 0, refunded: 0, net: 0, orders: 0 },
    );
    const pdf = await renderTablePdf({
      title: "Revenue summary",
      range: rangeLabel(from, to),
      practiceName: PRACTICE_NAME,
      columns: [
        { label: "Day", width: 100 },
        { label: "Orders", width: 80, rightAlign: true },
        { label: "Gross (USD)", width: 130, rightAlign: true },
        { label: "Refunded (USD)", width: 150, rightAlign: true },
        { label: "Net (USD)", width: 160, rightAlign: true },
      ],
      rows: rows.map((r) => [
        r.day,
        String(r.ordersCount),
        r.grossUsd.toFixed(2),
        r.refundedUsd.toFixed(2),
        r.netUsd.toFixed(2),
      ]),
      summaryLines: [
        `Orders: ${totals.orders}`,
        `Gross: $${totals.gross.toFixed(2)}`,
        `Refunded: $${totals.refunded.toFixed(2)}`,
        `Net: $${totals.net.toFixed(2)}`,
      ],
    });
    setDownloadHeaders(
      res,
      "application/pdf",
      `pennpaps-revenue-${rangeSlug(from, to)}.pdf`,
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  },
);

// ─────────────────────────────────────────────────────────────────
// REFUNDS JOURNAL — chronological refund ledger. Useful for AR
// reconciliation; the IIF / QBO output is the same as the
// returns.iif endpoint (which is the source of truth for refund
// transactions) so we don't add a parallel write here.
// ─────────────────────────────────────────────────────────────────

router.get(
  "/admin/reports/refunds-journal.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const rows = await fetchReturns(from, to);
    setDownloadHeaders(
      res,
      "text/csv; charset=utf-8",
      `pennpaps-refunds-${rangeSlug(from, to)}.csv`,
    );
    writeRefundsCsv(res, rows);
  },
);

router.get(
  "/admin/reports/refunds-journal.pdf",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const allReturns = await fetchReturns(from, to);
    const rows = allReturns.filter(
      (r) => r.refund_cents != null && r.refund_cents > 0,
    );
    const total = rows.reduce(
      (s, r) => s + centsToDollars(r.refund_cents),
      0,
    );
    const pdf = await renderTablePdf({
      title: "Refunds journal",
      range: rangeLabel(from, to),
      practiceName: PRACTICE_NAME,
      columns: [
        { label: "Return #", width: 100 },
        { label: "Order #", width: 100 },
        { label: "Refund ID", width: 180 },
        { label: "Refund (USD)", width: 110, rightAlign: true },
        { label: "Reason", width: 130 },
        { label: "Resolved", width: 100 },
      ],
      rows: rows.map((r) => [
        r.id.slice(0, 8),
        r.order_id?.slice(0, 8) ?? "",
        r.stripe_refund_id ?? "",
        (r.refund_cents! / 100).toFixed(2),
        r.reason ?? "",
        r.resolved_at?.slice(0, 10) ?? "",
      ]),
      summaryLines: [
        `Total refunds: ${rows.length}`,
        `Total amount refunded: $${total.toFixed(2)}`,
      ],
    });
    setDownloadHeaders(
      res,
      "application/pdf",
      `pennpaps-refunds-${rangeSlug(from, to)}.pdf`,
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  },
);

// Suppress the unused-import warning when there are no logger calls
// — kept around because future feature-flag-aware behavior here
// would log.
void logger;

export default router;
