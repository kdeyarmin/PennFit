// reports/revenue-summary.ts — the `revenue-summary` report: per-day
// revenue + refund + net rollup over the orders/returns streams.
// CSV + PDF (with the optional ?compare=true prior-period summary)
// plus the matching email-attachment builders.

import { renderTablePdf } from "../../../lib/report-pdf";
import { requirePermission } from "../../../middlewares/requireAdmin";
import { fetchOrders, type OrderRow } from "./orders";
import { fetchReturns, type ReturnRow } from "./returns";
import {
  bufferedRes,
  centsToDollars,
  escapeCsv,
  parseRange,
  practiceName,
  rangeLabel,
  rangeSlug,
  setDownloadHeaders,
  type ReportModule,
  type CsvSink,
} from "./shared";

// Aggregated revenue + refund rollup, one row per calendar day.
export interface RevenueByDay {
  day: string;
  ordersCount: number;
  grossUsd: number;
  refundedUsd: number;
  netUsd: number;
}

export function rollupRevenue(
  orders: OrderRow[],
  returns: ReturnRow[],
): RevenueByDay[] {
  // Accumulate in integer cents and convert to dollars once at the end —
  // summing per-row `cents / 100` floats accumulates precision error
  // across large day buckets.
  const byDay = new Map<
    string,
    { ordersCount: number; grossCents: number; refundedCents: number }
  >();
  function bucket(day: string) {
    let v = byDay.get(day);
    if (!v) {
      v = { ordersCount: 0, grossCents: 0, refundedCents: 0 };
      byDay.set(day, v);
    }
    return v;
  }
  for (const o of orders) {
    if (
      o.status !== "paid" &&
      o.status !== "shipped" &&
      o.status !== "delivered"
    ) {
      continue;
    }
    const day = (o.paid_at ?? o.created_at).slice(0, 10);
    const b = bucket(day);
    b.ordersCount += 1;
    b.grossCents += o.amount_total_cents ?? 0;
  }
  for (const r of returns) {
    if (r.refund_cents == null || r.refund_cents === 0) continue;
    const day = (r.resolved_at ?? r.approved_at ?? r.created_at).slice(0, 10);
    const b = bucket(day);
    b.refundedCents += r.refund_cents;
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, v]) => ({
      day,
      ordersCount: v.ordersCount,
      grossUsd: centsToDollars(v.grossCents),
      refundedUsd: centsToDollars(v.refundedCents),
      netUsd: centsToDollars(v.grossCents - v.refundedCents),
    }));
}

export function writeRevenueCsv(res: CsvSink, rows: RevenueByDay[]): void {
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

// Compute the matching prior period ending the day BEFORE `from`,
// of equal length. Example: from=2026-04-10, to=2026-04-19 (10
// days inclusive) → prior period is 2026-03-31 through 2026-04-09.
// Returned as an inclusive `[priorFrom, priorTo]` Date range that
// can be passed straight back into fetchOrders / fetchReturns.
function computePriorPeriod(
  from: Date,
  to: Date,
): { priorFrom: Date; priorTo: Date } {
  const lengthMs = to.getTime() - from.getTime();
  const priorTo = new Date(from.getTime() - 86400_000); // day before `from`
  const priorFrom = new Date(priorTo.getTime() - lengthMs);
  return { priorFrom, priorTo };
}

function comparePeriodRequested(req: import("express").Request): boolean {
  const v = req.query.compare;
  return v === "true" || v === "1";
}

// Aggregate the rollup rows into a single totals object — re-used
// by the revenue-summary PDF + the compare-to-prior summary.
export function totalsFromRevenueRows(rows: RevenueByDay[]): {
  orders: number;
  gross: number;
  refunded: number;
  net: number;
} {
  return rows.reduce(
    (acc, r) => ({
      orders: acc.orders + r.ordersCount,
      gross: acc.gross + r.grossUsd,
      refunded: acc.refunded + r.refundedUsd,
      net: acc.net + r.netUsd,
    }),
    { orders: 0, gross: 0, refunded: 0, net: 0 },
  );
}

function deltaPercent(current: number, prior: number): string {
  if (prior === 0) {
    if (current === 0) return "0.0%";
    // Avoid divide-by-zero. Convention: report "+∞%" (or n/a) when
    // the prior period had zero — common when the storefront just
    // launched. We pick "n/a" because percentages over an empty
    // baseline are misleading; the operator can see the absolute
    // delta on the line above.
    return "n/a";
  }
  const pct = ((current - prior) / prior) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export const revenueSummaryReport: ReportModule = {
  slug: "revenue-summary",

  // ─────────────────────────────────────────────────────────────────
  // REVENUE SUMMARY — per-day rollup. CSV + PDF + (IIF / QBO reuse
  // the underlying orders rows, so the combined export lives on the
  // orders endpoints — we don't double-emit the same transactions in
  // the revenue download).
  // ─────────────────────────────────────────────────────────────────
  register(router) {
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
        const compare = comparePeriodRequested(req);

        // Always fetch the current period. Only fetch the prior period
        // when ?compare=true to keep the default download fast.
        const [orders, returns] = await Promise.all([
          fetchOrders(from, to),
          fetchReturns(from, to),
        ]);
        const rows = rollupRevenue(orders, returns);
        const totals = totalsFromRevenueRows(rows);

        const summaryLines: string[] = [
          `Orders: ${totals.orders}`,
          `Gross: $${totals.gross.toFixed(2)}`,
          `Refunded: $${totals.refunded.toFixed(2)}`,
          `Net: $${totals.net.toFixed(2)}`,
        ];

        if (compare) {
          const { priorFrom, priorTo } = computePriorPeriod(from, to);
          const [priorOrders, priorReturns] = await Promise.all([
            fetchOrders(priorFrom, priorTo),
            fetchReturns(priorFrom, priorTo),
          ]);
          const priorRows = rollupRevenue(priorOrders, priorReturns);
          const priorTotals = totalsFromRevenueRows(priorRows);
          summaryLines.push("");
          summaryLines.push(`Compared to ${rangeLabel(priorFrom, priorTo)}:`);
          summaryLines.push(
            `  Prior orders: ${priorTotals.orders} (${deltaPercent(totals.orders, priorTotals.orders)} vs prior)`,
          );
          summaryLines.push(
            `  Prior gross: $${priorTotals.gross.toFixed(2)} (${deltaPercent(totals.gross, priorTotals.gross)})`,
          );
          summaryLines.push(
            `  Prior net: $${priorTotals.net.toFixed(2)} (${deltaPercent(totals.net, priorTotals.net)})`,
          );
        }

        const pdf = await renderTablePdf({
          title: "Revenue summary",
          range: rangeLabel(from, to),
          practiceName: practiceName(),
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
          summaryLines,
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
  },

  async buildEmailCsv(from, to) {
    const { res, collect } = bufferedRes();
    const [orders, returns] = await Promise.all([
      fetchOrders(from, to),
      fetchReturns(from, to),
    ]);
    writeRevenueCsv(res, rollupRevenue(orders, returns));
    return collect();
  },

  // The emailed PDF never includes the compare-to-prior block — it
  // matches the default (no ?compare) GET download.
  async buildEmailPdf(from, to) {
    const [orders, returns] = await Promise.all([
      fetchOrders(from, to),
      fetchReturns(from, to),
    ]);
    const rows = rollupRevenue(orders, returns);
    const totals = totalsFromRevenueRows(rows);
    const pdf = await renderTablePdf({
      title: "Revenue summary",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
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
    return pdf;
  },
};
