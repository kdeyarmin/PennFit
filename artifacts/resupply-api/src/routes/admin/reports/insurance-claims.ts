// reports/insurance-claims.ts — the `insurance-claims` report:
// billing-side claims in range (cf. cash-pay orders); QB exports
// cover the `paid` slice keyed on payer-cash receipts. CSV / PDF /
// IIF / QBO CSV downloads plus the matching email-attachment
// builders.
//
// PHI posture: `patient_id` is HIPAA-protected; we hash it via
// `customerKeyForId` so the export only carries an opaque short
// fingerprint. Free-text columns (`notes`, `denial_reason`) are
// intentionally NOT pulled — they're operator scratch fields that
// commonly include PHI ("patient reports nightly mask leak") and
// have no place in a CSV/PDF that gets emailed around.

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

export interface InsuranceClaimRow {
  id: string;
  patient_id: string;
  payer_name: string;
  claim_number: string | null;
  date_of_service: string;
  status: string;
  total_billed_cents: number;
  total_allowed_cents: number;
  total_paid_cents: number;
  patient_responsibility_cents: number;
  submitted_at: string | null;
  decision_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export async function fetchInsuranceClaims(
  from: Date,
  to: Date,
): Promise<InsuranceClaimRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  // Date-of-service is the canonical billing-period anchor — payors
  // reconcile against it, not the row's created_at. Operators
  // chasing aging windows ("denials in last 30 DOS days") expect the
  // range to clamp on DOS.
  const { data, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_name, claim_number, date_of_service, status, total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents, submitted_at, decision_at, paid_at, created_at",
    )
    .gte("date_of_service", from.toISOString().slice(0, 10))
    .lte("date_of_service", to.toISOString().slice(0, 10))
    .order("date_of_service", { ascending: false });
  if (error) throw error;
  return (data ?? []) as InsuranceClaimRow[];
}

export function writeInsuranceClaimsCsv(
  res: import("express").Response,
  rows: InsuranceClaimRow[],
): void {
  const headers = [
    "claim_id",
    "patient_key", // hashed prefix, not raw patient_id
    "payer_name",
    "claim_number",
    "date_of_service",
    "status",
    "billed_usd",
    "allowed_usd",
    "paid_usd",
    "patient_responsibility_usd",
    "submitted_at",
    "decision_at",
    "paid_at",
  ];
  res.write(headers.join(",") + "\n");
  for (const r of rows) {
    const row = [
      r.id,
      customerKeyForId(r.patient_id),
      r.payer_name,
      r.claim_number,
      r.date_of_service,
      r.status,
      (r.total_billed_cents / 100).toFixed(2),
      (r.total_allowed_cents / 100).toFixed(2),
      (r.total_paid_cents / 100).toFixed(2),
      (r.patient_responsibility_cents / 100).toFixed(2),
      r.submitted_at,
      r.decision_at,
      r.paid_at,
    ];
    res.write(row.map(escapeCsv).join(",") + "\n");
  }
  res.end();
}

// Build QuickBooks rows from the `paid` slice of claims. Each
// "paid" claim becomes a positive-amount ORDER row (the payor
// cash receipt) keyed on the hashed patient prefix. Unpaid /
// denied / pending statuses are excluded because they don't
// represent received cash — they belong in AR aging, not the
// general ledger.
export function buildQbRowsFromClaims(
  rows: InsuranceClaimRow[],
): QuickbooksRowInput[] {
  return rows
    .filter((r) => r.status === "paid" && r.total_paid_cents > 0)
    .map((r) => ({
      txnId: `CLM-${r.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`,
      date: (r.paid_at ?? r.decision_at ?? r.date_of_service).slice(0, 10),
      amountUsd: centsToDollars(r.total_paid_cents),
      kind: "ORDER" as const,
      memo: `${r.payer_name}${r.claim_number ? ` — ${r.claim_number}` : ""}`,
      customerKey: customerKeyForId(r.patient_id),
    }));
}

export const insuranceClaimsReport: ReportModule = {
  slug: "insurance-claims",

  // ─────────────────────────────────────────────────────────────────
  // INSURANCE CLAIMS — CSV / PDF / IIF / QBO CSV
  // ─────────────────────────────────────────────────────────────────
  register(router) {
    router.get(
      "/admin/reports/insurance-claims.csv",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchInsuranceClaims(from, to);
        setDownloadHeaders(
          res,
          "text/csv; charset=utf-8",
          `pennpaps-insurance-claims-${rangeSlug(from, to)}.csv`,
        );
        writeInsuranceClaimsCsv(res, rows);
      },
    );

    router.get(
      "/admin/reports/insurance-claims.pdf",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchInsuranceClaims(from, to);
        const totals = rows.reduce(
          (acc, r) => ({
            billed: acc.billed + r.total_billed_cents / 100,
            paid: acc.paid + r.total_paid_cents / 100,
            patientResp: acc.patientResp + r.patient_responsibility_cents / 100,
          }),
          { billed: 0, paid: 0, patientResp: 0 },
        );
        const pdf = await renderTablePdf({
          title: "Insurance claims",
          range: rangeLabel(from, to),
          practiceName: practiceName(),
          columns: [
            { label: "Claim #", width: 100 },
            { label: "DOS", width: 70 },
            { label: "Payer", width: 130 },
            { label: "Status", width: 65 },
            { label: "Billed", width: 70, rightAlign: true },
            { label: "Paid", width: 70, rightAlign: true },
            { label: "Patient", width: 75, rightAlign: true },
            { label: "Patient key", width: 95 },
          ],
          rows: rows.map((r) => [
            r.claim_number ?? r.id.slice(0, 8),
            r.date_of_service,
            r.payer_name,
            r.status,
            (r.total_billed_cents / 100).toFixed(2),
            (r.total_paid_cents / 100).toFixed(2),
            (r.patient_responsibility_cents / 100).toFixed(2),
            customerKeyForId(r.patient_id),
          ]),
          summaryLines: [
            `Total claims in range: ${rows.length}`,
            `Total billed: $${totals.billed.toFixed(2)}`,
            `Total paid (payor receipts): $${totals.paid.toFixed(2)}`,
            `Patient responsibility: $${totals.patientResp.toFixed(2)}`,
          ],
        });
        setDownloadHeaders(
          res,
          "application/pdf",
          `pennpaps-insurance-claims-${rangeSlug(from, to)}.pdf`,
        );
        res.setHeader("Content-Length", String(pdf.length));
        res.end(pdf);
      },
    );

    router.get(
      "/admin/reports/insurance-claims.iif",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchInsuranceClaims(from, to);
        const iif = await renderIifWithAccounts({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
          rows: buildQbRowsFromClaims(rows),
        });
        setDownloadHeaders(
          res,
          "application/octet-stream",
          `pennpaps-insurance-claims-${rangeSlug(from, to)}.iif`,
        );
        res.end(iif);
      },
    );

    router.get(
      "/admin/reports/insurance-claims.qbo.csv",
      requirePermission("reports.read"),
      async (req, res) => {
        const { from, to } = parseRange(req);
        const rows = await fetchInsuranceClaims(from, to);
        const csv = renderQboCsv({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          practiceName: practiceName(),
          rows: buildQbRowsFromClaims(rows),
        });
        setDownloadHeaders(
          res,
          "text/csv; charset=utf-8",
          `pennpaps-insurance-claims-${rangeSlug(from, to)}.qbo.csv`,
        );
        res.end(csv);
      },
    );
  },

  async buildEmailCsv(from, to) {
    const { res, collect } = bufferedRes();
    writeInsuranceClaimsCsv(
      res as unknown as import("express").Response,
      await fetchInsuranceClaims(from, to),
    );
    return collect();
  },

  async buildEmailPdf(from, to) {
    const rows = await fetchInsuranceClaims(from, to);
    const totals = rows.reduce(
      (acc, r) => ({
        billed: acc.billed + r.total_billed_cents / 100,
        paid: acc.paid + r.total_paid_cents / 100,
        patientResp: acc.patientResp + r.patient_responsibility_cents / 100,
      }),
      { billed: 0, paid: 0, patientResp: 0 },
    );
    const pdf = await renderTablePdf({
      title: "Insurance claims",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
      columns: [
        { label: "Claim #", width: 100 },
        { label: "DOS", width: 70 },
        { label: "Payer", width: 130 },
        { label: "Status", width: 65 },
        { label: "Billed", width: 70, rightAlign: true },
        { label: "Paid", width: 70, rightAlign: true },
        { label: "Patient", width: 75, rightAlign: true },
        { label: "Patient key", width: 95 },
      ],
      rows: rows.map((r) => [
        r.claim_number ?? r.id.slice(0, 8),
        r.date_of_service,
        r.payer_name,
        r.status,
        (r.total_billed_cents / 100).toFixed(2),
        (r.total_paid_cents / 100).toFixed(2),
        (r.patient_responsibility_cents / 100).toFixed(2),
        customerKeyForId(r.patient_id),
      ]),
      summaryLines: [
        `Total claims in range: ${rows.length}`,
        `Total billed: $${totals.billed.toFixed(2)}`,
        `Total paid (payor receipts): $${totals.paid.toFixed(2)}`,
        `Patient responsibility: $${totals.patientResp.toFixed(2)}`,
      ],
    });
    return pdf;
  },

  async buildEmailQbRows(from, to) {
    return buildQbRowsFromClaims(await fetchInsuranceClaims(from, to));
  },
};
