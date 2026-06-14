// reports/all-financial.ts — the `all-financial` report: the
// one-click "export everything" bundle. CSV / PDF / IIF / QBO CSV
// downloads plus the matching email-attachment builders.
//
// Unions every cash-bearing row from the storefront + billing sides
// into a single chronological ledger: shop orders, shop refunds,
// insurance (payer) receipts, and patient-responsibility payments.
// Reuses the existing per-stream QB builders verbatim so the combined
// file posts each row to exactly the same account it would in its
// standalone export (orders → Sales:Online Orders, refunds → Sales
// Returns and Allowances, patient payments → Patient Payments, …).
// IIF / QBO consume the QuickbooksRowInput fields; the CSV/PDF use
// the `category` + `source` tags for a human-readable ledger.

import {
  renderQboCsv,
  type QuickbooksRowInput,
} from "../../../lib/quickbooks-export";
import { renderTablePdf } from "../../../lib/report-pdf";
import { requirePermission } from "../../../middlewares/requireAdmin";
import {
  buildQbRowsFromClaims,
  fetchInsuranceClaims,
  type InsuranceClaimRow,
} from "./insurance-claims";
import { buildQbRowsFromOrders, fetchOrders, type OrderRow } from "./orders";
import {
  buildQbRowsFromPatientPayments,
  fetchPatientPayments,
  type PatientPaymentRow,
} from "./patient-payments";
import {
  buildQbRowsFromReturns,
  fetchReturns,
  type ReturnRow,
} from "./returns";
import {
  bufferedRes,
  escapeCsv,
  parseRange,
  practiceName,
  rangeLabel,
  rangeSlug,
  renderIifWithAccounts,
  setDownloadHeaders,
  type ReportModule,
  type CsvSink,
} from "./shared";

export type CombinedFinancialRow = QuickbooksRowInput & {
  category: string;
  source: string;
};

export function buildCombinedFinancialRows(
  orders: OrderRow[],
  returns: ReturnRow[],
  claims: InsuranceClaimRow[],
  payments: PatientPaymentRow[],
): CombinedFinancialRow[] {
  const tag =
    (category: string, source: string) =>
    (r: QuickbooksRowInput): CombinedFinancialRow => ({
      ...r,
      category,
      source,
    });
  const rows: CombinedFinancialRow[] = [
    ...buildQbRowsFromOrders(orders).map(tag("Shop order", "shop")),
    ...buildQbRowsFromReturns(returns).map(tag("Shop refund", "shop")),
    ...buildQbRowsFromClaims(claims).map(tag("Insurance payment", "payer")),
    ...buildQbRowsFromPatientPayments(payments).map(
      tag("Patient payment", "patient"),
    ),
  ];
  // Ascending by date for a clean chronological general-ledger view.
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

export async function fetchCombinedFinancial(
  from: Date,
  to: Date,
): Promise<CombinedFinancialRow[]> {
  const [orders, returns, claims, payments] = await Promise.all([
    fetchOrders(from, to),
    fetchReturns(from, to),
    fetchInsuranceClaims(from, to),
    fetchPatientPayments(from, to),
  ]);
  return buildCombinedFinancialRows(orders, returns, claims, payments);
}

export function writeCombinedFinancialCsv(
  res: CsvSink,
  rows: CombinedFinancialRow[],
): void {
  const headers = [
    "date",
    "category",
    "kind", // ORDER (cash in) | REFUND (cash out)
    "amount_usd", // signed: positive = inflow, negative = refund
    "customer_key", // hashed prefix, not a name
    "reference",
    "source",
  ];
  res.write(headers.join(",") + "\n");
  for (const r of rows) {
    res.write(
      [
        r.date,
        r.category,
        r.kind,
        r.amountUsd.toFixed(2),
        r.customerKey,
        r.memo,
        r.source,
      ]
        .map(escapeCsv)
        .join(",") + "\n",
    );
  }
  res.end();
}

export const allFinancialReport: ReportModule = {
  slug: "all-financial",

  // ─────────────────────────────────────────────────────────────────
  // ALL-FINANCIAL — the one-click "export everything" bundle.
  // CSV / PDF / IIF / QBO CSV, each a single file unioning every
  // cash-bearing row in the range. This is the report the task asks
  // for: "export ALL financial data into QuickBooks easily" — one
  // download per QuickBooks edition, not four.
  // ─────────────────────────────────────────────────────────────────
  register(router) {
    router.get(
      "/admin/reports/all-financial.csv",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchCombinedFinancial(from, to);
        setDownloadHeaders(
          res,
          "text/csv; charset=utf-8",
          `pennpaps-all-financial-${rangeSlug(from, to)}.csv`,
        );
        writeCombinedFinancialCsv(res, rows);
      },
    );

    router.get(
      "/admin/reports/all-financial.pdf",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchCombinedFinancial(from, to);
        const inflow = rows
          .filter((r) => r.amountUsd > 0)
          .reduce((s, r) => s + r.amountUsd, 0);
        const refunds = rows
          .filter((r) => r.amountUsd < 0)
          .reduce((s, r) => s + r.amountUsd, 0);
        const pdf = await renderTablePdf({
          title: "All financial data",
          range: rangeLabel(from, to),
          practiceName: practiceName(),
          columns: [
            { label: "Date", width: 75 },
            { label: "Category", width: 130 },
            { label: "Amount (USD)", width: 95, rightAlign: true },
            { label: "Customer", width: 110 },
            { label: "Reference", width: 200 },
          ],
          rows: rows.map((r) => [
            r.date,
            r.category,
            r.amountUsd.toFixed(2),
            r.customerKey,
            r.memo,
          ]),
          summaryLines: [
            `Transactions in range: ${rows.length}`,
            `Gross inflow: $${inflow.toFixed(2)}`,
            `Refunds: $${refunds.toFixed(2)}`,
            `Net: $${(inflow + refunds).toFixed(2)}`,
          ],
        });
        setDownloadHeaders(
          res,
          "application/pdf",
          `pennpaps-all-financial-${rangeSlug(from, to)}.pdf`,
        );
        res.setHeader("Content-Length", String(pdf.length));
        res.end(pdf);
      },
    );

    router.get(
      "/admin/reports/all-financial.iif",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchCombinedFinancial(from, to);
        const iif = await renderIifWithAccounts({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
          rows,
        });
        setDownloadHeaders(
          res,
          "application/octet-stream",
          `pennpaps-all-financial-${rangeSlug(from, to)}.iif`,
        );
        res.end(iif);
      },
    );

    router.get(
      "/admin/reports/all-financial.qbo.csv",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchCombinedFinancial(from, to);
        const csv = renderQboCsv({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
          rows,
        });
        setDownloadHeaders(
          res,
          "text/csv; charset=utf-8",
          `pennpaps-all-financial-${rangeSlug(from, to)}.qbo.csv`,
        );
        res.end(csv);
      },
    );
  },

  async buildEmailCsv(from, to) {
    const { res, collect } = bufferedRes();
    writeCombinedFinancialCsv(res, await fetchCombinedFinancial(from, to));
    return collect();
  },

  async buildEmailPdf(from, to) {
    const rows = await fetchCombinedFinancial(from, to);
    const inflow = rows
      .filter((r) => r.amountUsd > 0)
      .reduce((s, r) => s + r.amountUsd, 0);
    const refunds = rows
      .filter((r) => r.amountUsd < 0)
      .reduce((s, r) => s + r.amountUsd, 0);
    const pdf = await renderTablePdf({
      title: "All financial data",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
      columns: [
        { label: "Date", width: 75 },
        { label: "Category", width: 130 },
        { label: "Amount (USD)", width: 95, rightAlign: true },
        { label: "Customer", width: 110 },
        { label: "Reference", width: 200 },
      ],
      rows: rows.map((r) => [
        r.date,
        r.category,
        r.amountUsd.toFixed(2),
        r.customerKey,
        r.memo,
      ]),
      summaryLines: [
        `Transactions in range: ${rows.length}`,
        `Gross inflow: $${inflow.toFixed(2)}`,
        `Refunds: $${refunds.toFixed(2)}`,
        `Net: $${(inflow + refunds).toFixed(2)}`,
      ],
    });
    return pdf;
  },

  async buildEmailQbRows(from, to) {
    return fetchCombinedFinancial(from, to);
  },
};
