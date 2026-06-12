// reports/orders.ts — the `orders` report: Stripe checkout sessions
// in range. CSV / PDF / IIF / QBO CSV downloads plus the matching
// email-attachment builders.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  customerKeyForId,
  renderQboCsv,
  type QuickbooksRowInput,
} from "../../../lib/quickbooks-export";
import { renderTablePdf } from "../../../lib/report-pdf";
import { requirePermission } from "../../../middlewares/requireAdmin";
import {
  bufferedRes,
  centsToDollars,
  escapeCsv,
  parseRange,
  practiceName,
  rangeLabel,
  rangeSlug,
  renderIifWithAccounts,
  setDownloadHeaders,
  type ReportModule,
} from "./shared";

export interface OrderRow {
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

export async function fetchOrders(from: Date, to: Date): Promise<OrderRow[]> {
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

export function writeOrdersCsv(
  res: import("express").Response,
  orders: OrderRow[],
): void {
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

export function buildQbRowsFromOrders(
  orders: OrderRow[],
): QuickbooksRowInput[] {
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

export const ordersReport: ReportModule = {
  slug: "orders",

  // ─────────────────────────────────────────────────────────────────
  // ORDERS — CSV / PDF / IIF / QBO CSV
  // ─────────────────────────────────────────────────────────────────
  register(router) {
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
          practiceName: practiceName(),
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
        const iif = await renderIifWithAccounts({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
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
          practiceName: practiceName(),
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
  },

  async buildEmailCsv(from, to) {
    const { res, collect } = bufferedRes();
    writeOrdersCsv(
      res as unknown as import("express").Response,
      await fetchOrders(from, to),
    );
    return collect();
  },

  async buildEmailPdf(from, to) {
    const orders = await fetchOrders(from, to);
    const totalUsd = orders.reduce(
      (s, o) => s + centsToDollars(o.amount_total_cents),
      0,
    );
    const pdf = await renderTablePdf({
      title: "Cash-pay orders",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
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
    return pdf;
  },

  async buildEmailQbRows(from, to) {
    return buildQbRowsFromOrders(await fetchOrders(from, to));
  },
};
