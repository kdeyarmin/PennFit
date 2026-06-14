// reports/patient-payments.ts — the `patient-payments` report:
// patient-responsibility cash actually collected (Stripe
// PaymentIntents + mail-in checks). CSV / PDF / IIF / QBO CSV
// downloads plus the matching email-attachment builders.
//
// This is the patient-responsibility cash the practice actually
// collected (Stripe card payments via the portal/CSR, plus mail-in
// checks recorded by staff). It is DISJOINT from the insurance-claims
// export: claims carry the payer's `total_paid_cents` (insurance
// cash), patient_payments carries the patient's own cash. Exporting
// both is additive, never double-counting.
//
// PHI posture: `patient_id` is hashed via `customerKeyForId`; the
// free-text `note` / `failure_reason` columns (which can hold PHI —
// "check memo: re: my husband's CPAP") are intentionally NOT pulled,
// mirroring the insurance-claims fetcher.

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
  type CsvSink,
} from "./shared";

export interface PatientPaymentRow {
  id: string;
  patient_id: string;
  stripe_payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  source: string;
  succeeded_at: string | null;
  created_at: string;
}

export async function fetchPatientPayments(
  from: Date,
  to: Date,
): Promise<PatientPaymentRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  // Clamp on created_at (consistent with orders/returns); the QB
  // builder anchors each receipt on succeeded_at so the ledger date
  // reflects when the cash actually landed.
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .select(
      "id, patient_id, stripe_payment_intent_id, amount_cents, currency, status, source, succeeded_at, created_at",
    )
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PatientPaymentRow[];
}

export function writePatientPaymentsCsv(
  res: CsvSink,
  rows: PatientPaymentRow[],
): void {
  const headers = [
    "payment_id",
    "patient_key", // hashed prefix, not raw patient_id
    "stripe_payment_intent_id",
    "amount_usd",
    "currency",
    "status",
    "source",
    "succeeded_at",
    "created_at",
  ];
  res.write(headers.join(",") + "\n");
  for (const p of rows) {
    const row = [
      p.id,
      customerKeyForId(p.patient_id),
      p.stripe_payment_intent_id,
      (p.amount_cents / 100).toFixed(2),
      p.currency,
      p.status,
      p.source,
      p.succeeded_at,
      p.created_at,
    ];
    res.write(row.map(escapeCsv).join(",") + "\n");
  }
  res.end();
}

// Build QuickBooks rows from the `succeeded` slice of patient
// payments. Each becomes a positive-amount ORDER row (a cash
// receipt) routed to a dedicated "Patient Payments" income account so
// it lands on its own P&L line instead of being lumped in with
// storefront sales. Pending / failed / cancelled payments are
// excluded — they're not received cash.
export function buildQbRowsFromPatientPayments(
  rows: PatientPaymentRow[],
): QuickbooksRowInput[] {
  return rows
    .filter((p) => p.status === "succeeded" && p.amount_cents > 0)
    .map((p) => ({
      txnId: `PAY-${p.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`,
      date: (p.succeeded_at ?? p.created_at).slice(0, 10),
      amountUsd: centsToDollars(p.amount_cents),
      kind: "ORDER" as const,
      memo: p.stripe_payment_intent_id ?? `patient payment (${p.source})`,
      customerKey: customerKeyForId(p.patient_id),
      incomeAccount: "Patient Payments",
    }));
}

export const patientPaymentsReport: ReportModule = {
  slug: "patient-payments",

  // ─────────────────────────────────────────────────────────────────
  // PATIENT PAYMENTS — CSV / PDF / IIF / QBO CSV
  // ─────────────────────────────────────────────────────────────────
  register(router) {
    router.get(
      "/admin/reports/patient-payments.csv",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchPatientPayments(from, to);
        setDownloadHeaders(
          res,
          "text/csv; charset=utf-8",
          `pennpaps-patient-payments-${rangeSlug(from, to)}.csv`,
        );
        writePatientPaymentsCsv(res, rows);
      },
    );

    router.get(
      "/admin/reports/patient-payments.pdf",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchPatientPayments(from, to);
        const collected = rows
          .filter((p) => p.status === "succeeded")
          .reduce((s, p) => s + centsToDollars(p.amount_cents), 0);
        const pdf = await renderTablePdf({
          title: "Patient payments",
          range: rangeLabel(from, to),
          practiceName: practiceName(),
          columns: [
            { label: "Payment #", width: 100 },
            { label: "Date", width: 80 },
            { label: "Status", width: 80 },
            { label: "Amount (USD)", width: 90, rightAlign: true },
            { label: "Source", width: 90 },
            { label: "Patient key", width: 110 },
          ],
          rows: rows.map((p) => [
            p.id.slice(0, 8),
            (p.succeeded_at ?? p.created_at).slice(0, 10),
            p.status,
            (p.amount_cents / 100).toFixed(2),
            p.source,
            customerKeyForId(p.patient_id),
          ]),
          summaryLines: [
            `Payments in range: ${rows.length}`,
            `Succeeded: ${rows.filter((p) => p.status === "succeeded").length}`,
            `Cash collected (succeeded): $${collected.toFixed(2)}`,
          ],
        });
        setDownloadHeaders(
          res,
          "application/pdf",
          `pennpaps-patient-payments-${rangeSlug(from, to)}.pdf`,
        );
        res.setHeader("Content-Length", String(pdf.length));
        res.end(pdf);
      },
    );

    router.get(
      "/admin/reports/patient-payments.iif",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchPatientPayments(from, to);
        const iif = await renderIifWithAccounts({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
          rows: buildQbRowsFromPatientPayments(rows),
        });
        setDownloadHeaders(
          res,
          "application/octet-stream",
          `pennpaps-patient-payments-${rangeSlug(from, to)}.iif`,
        );
        res.end(iif);
      },
    );

    router.get(
      "/admin/reports/patient-payments.qbo.csv",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchPatientPayments(from, to);
        const csv = renderQboCsv({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
          rows: buildQbRowsFromPatientPayments(rows),
        });
        setDownloadHeaders(
          res,
          "text/csv; charset=utf-8",
          `pennpaps-patient-payments-${rangeSlug(from, to)}.qbo.csv`,
        );
        res.end(csv);
      },
    );
  },

  async buildEmailCsv(from, to) {
    const { res, collect } = bufferedRes();
    writePatientPaymentsCsv(res, await fetchPatientPayments(from, to));
    return collect();
  },

  async buildEmailPdf(from, to) {
    const rows = await fetchPatientPayments(from, to);
    const collected = rows
      .filter((p) => p.status === "succeeded")
      .reduce((s, p) => s + centsToDollars(p.amount_cents), 0);
    const pdf = await renderTablePdf({
      title: "Patient payments",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
      columns: [
        { label: "Payment #", width: 100 },
        { label: "Date", width: 80 },
        { label: "Status", width: 80 },
        { label: "Amount (USD)", width: 90, rightAlign: true },
        { label: "Source", width: 90 },
        { label: "Patient key", width: 110 },
      ],
      rows: rows.map((p) => [
        p.id.slice(0, 8),
        (p.succeeded_at ?? p.created_at).slice(0, 10),
        p.status,
        (p.amount_cents / 100).toFixed(2),
        p.source,
        customerKeyForId(p.patient_id),
      ]),
      summaryLines: [
        `Payments in range: ${rows.length}`,
        `Succeeded: ${rows.filter((p) => p.status === "succeeded").length}`,
        `Cash collected (succeeded): $${collected.toFixed(2)}`,
      ],
    });
    return pdf;
  },

  async buildEmailQbRows(from, to) {
    return buildQbRowsFromPatientPayments(await fetchPatientPayments(from, to));
  },
};
