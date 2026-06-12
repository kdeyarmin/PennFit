// reports/returns.ts — the `returns` report: comfort-guarantee
// returns / RMAs in range. CSV / PDF / IIF / QBO CSV downloads plus
// the matching email-attachment builders. Also exports the shared
// `fetchReturns` used by the revenue-summary / refunds-journal /
// all-financial reports.

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

export interface ReturnRow {
  id: string;
  order_id: string | null;
  customer_id: string | null;
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

export async function fetchReturns(from: Date, to: Date): Promise<ReturnRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .select(
      "id, order_id, customer_id, stripe_session_id, status, reason, resolution, refund_cents, stripe_refund_id, exchange_product_id, created_at, approved_at, received_at, resolved_at, closed_at",
    )
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ReturnRow[];
}

export function writeReturnsCsv(
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

export function buildQbRowsFromReturns(
  rows: ReturnRow[],
): QuickbooksRowInput[] {
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
      customerKey: customerKeyForId(r.customer_id),
    }));
}

export const returnsReport: ReportModule = {
  slug: "returns",

  // ─────────────────────────────────────────────────────────────────
  // RETURNS — CSV / PDF / IIF / QBO CSV
  // ─────────────────────────────────────────────────────────────────
  register(router) {
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
          practiceName: practiceName(),
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
        const iif = await renderIifWithAccounts({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
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
          practiceName: practiceName(),
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
  },

  async buildEmailCsv(from, to) {
    const { res, collect } = bufferedRes();
    writeReturnsCsv(
      res as unknown as import("express").Response,
      await fetchReturns(from, to),
    );
    return collect();
  },

  // The email PDF deliberately uses a slimmer column shape than the
  // GET handler — the duplication is intentional (see the note on
  // the email route's per-slug PDF builders).
  async buildEmailPdf(from, to) {
    const rows = await fetchReturns(from, to);
    const refunded = rows.reduce((s, r) => s + (r.refund_cents ?? 0) / 100, 0);
    const pdf = await renderTablePdf({
      title: "Returns & RMAs",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
      columns: [
        { label: "Return #", width: 100 },
        { label: "Order #", width: 100 },
        { label: "Status", width: 80 },
        { label: "Reason", width: 130 },
        { label: "Refund (USD)", width: 100, rightAlign: true },
        { label: "Resolved", width: 90 },
      ],
      rows: rows.map((r) => [
        r.id.slice(0, 8),
        (r.order_id ?? "").slice(0, 8),
        r.status ?? "",
        r.reason ?? "",
        r.refund_cents !== null ? (r.refund_cents / 100).toFixed(2) : "",
        r.resolved_at?.slice(0, 10) ?? "",
      ]),
      summaryLines: [
        `Returns in range: ${rows.length}`,
        `Total refunded: $${refunded.toFixed(2)}`,
      ],
    });
    return pdf;
  },

  async buildEmailQbRows(from, to) {
    return buildQbRowsFromReturns(await fetchReturns(from, to));
  },
};
