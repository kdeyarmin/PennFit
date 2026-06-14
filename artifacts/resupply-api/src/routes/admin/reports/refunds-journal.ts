// reports/refunds-journal.ts — the `refunds-journal` report: a
// chronological refund ledger over the returns stream. CSV + PDF
// plus the matching email-attachment builders.

import { renderTablePdf } from "../../../lib/report-pdf";
import { requirePermission } from "../../../middlewares/requireAdmin";
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

export function writeRefundsCsv(res: CsvSink, rows: ReturnRow[]): void {
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

export const refundsJournalReport: ReportModule = {
  slug: "refunds-journal",

  // ─────────────────────────────────────────────────────────────────
  // REFUNDS JOURNAL — chronological refund ledger. Useful for AR
  // reconciliation; the IIF / QBO output is the same as the
  // returns.iif endpoint (which is the source of truth for refund
  // transactions) so we don't add a parallel write here.
  // ─────────────────────────────────────────────────────────────────
  register(router) {
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
          practiceName: practiceName(),
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
  },

  async buildEmailCsv(from, to) {
    const { res, collect } = bufferedRes();
    writeRefundsCsv(res, await fetchReturns(from, to));
    return collect();
  },

  // The email PDF deliberately uses a slimmer column shape than the
  // GET handler — the duplication is intentional (see the note on
  // the email route's per-slug PDF builders).
  async buildEmailPdf(from, to) {
    const allReturns = await fetchReturns(from, to);
    const rows = allReturns.filter(
      (r) => r.refund_cents != null && r.refund_cents > 0,
    );
    const totalUsd = rows.reduce((s, r) => s + (r.refund_cents ?? 0) / 100, 0);
    const pdf = await renderTablePdf({
      title: "Refunds journal",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
      columns: [
        { label: "Return #", width: 100 },
        { label: "Resolved", width: 90 },
        { label: "Refund (USD)", width: 130, rightAlign: true },
        { label: "Stripe refund", width: 200 },
      ],
      rows: rows.map((r) => [
        r.id.slice(0, 8),
        r.resolved_at?.slice(0, 10) ?? "",
        ((r.refund_cents ?? 0) / 100).toFixed(2),
        r.stripe_refund_id ?? "",
      ]),
      summaryLines: [
        `Refunds in range: ${rows.length}`,
        `Total refunded: $${totalUsd.toFixed(2)}`,
      ],
    });
    return pdf;
  },
};
