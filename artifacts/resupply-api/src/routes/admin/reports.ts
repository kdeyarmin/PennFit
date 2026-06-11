// /admin/reports/* — admin reporting surface.
//
// Each report exposes up to four download formats:
//   GET /admin/reports/<name>.csv           — operational CSV
//   GET /admin/reports/<name>.pdf           — printable PDF
//   GET /admin/reports/<name>.iif           — QuickBooks Desktop IIF
//   GET /admin/reports/<name>.qbo.csv       — QuickBooks Online CSV
//
// Reports:
//   orders             — Stripe checkout sessions in range
//   returns            — Comfort-guarantee returns / RMAs in range
//   revenue-summary    — per-day revenue + refund + net rollup
//   refunds-journal    — chronological refund ledger
//   insurance-claims   — billing-side claims in range (cf. cash-pay
//                         orders); QB exports cover the `paid` slice
//                         keyed on payer-cash receipts.
//   patient-payments   — patient-responsibility cash actually
//                         collected (Stripe PaymentIntents + mail-in
//                         checks). Disjoint from insurance-claims
//                         (payer cash) so the two never double-count.
//                         QB exports post the `succeeded` slice to a
//                         dedicated "Patient Payments" income account.
//   all-financial      — the one-click "export everything" bundle:
//                         every cash-bearing row above (orders +
//                         refunds + payer receipts + patient payments)
//                         unioned into a single chronological file per
//                         format, so a bookkeeper imports ONE artifact
//                         per QuickBooks edition instead of chasing
//                         four separate downloads.
//   customer-activity  — aggregated storefront customer activity per
//                         day (new signups, returning-customer orders,
//                         active-customer count); count-only so the
//                         export carries no PHI/PII even at the
//                         storefront-customer level.
//
// All endpoints require the `reports.read` permission. Date range
// defaults to the last 30 days; max 90 days per export. PHI posture:
// the storefront reports are cash-pay only and identifiers are
// hashed prefixes (`customerKeyForId`); insurance-claims rows carry
// `patient_id` as a hashed prefix and omit free-text fields
// (`notes`, `denial_reason`) that could contain PHI. The
// customer-activity report is count-only and never serialises an
// individual customer id.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import {
  GL_ACCOUNT_DEFAULTS,
  loadGlAccounts,
} from "../../lib/billing/gl-accounts";
import { logger } from "../../lib/logger";
import {
  customerKeyForId,
  renderIif,
  renderQboCsv,
  type QuickbooksExportInput,
  type QuickbooksRowInput,
} from "../../lib/quickbooks-export";
import { renderTablePdf } from "../../lib/report-pdf";

// Render an IIF with the owner-configured GL accounts (owner #O3).
// Loads the mapping once, applies deposit/revenue/refund to the export,
// and remaps patient-pay rows (tagged with the default patient-pay
// account) to the configured one. Defaults leave the output unchanged.
async function renderIifWithAccounts(
  base: Omit<QuickbooksExportInput, "accounts">,
): Promise<string> {
  const accounts = await loadGlAccounts();
  const rows =
    accounts.patientPay === GL_ACCOUNT_DEFAULTS.patientPay
      ? base.rows
      : base.rows.map((r) =>
          r.incomeAccount === GL_ACCOUNT_DEFAULTS.patientPay
            ? { ...r, incomeAccount: accounts.patientPay }
            : r,
        );
  return renderIif({
    ...base,
    rows,
    accounts: {
      deposit: accounts.deposit,
      revenue: accounts.revenue,
      refund: accounts.refund,
    },
  });
}
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
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
  let to = toRaw ? new Date(toRaw + "T23:59:59Z") : now;
  let from = fromRaw
    ? new Date(fromRaw + "T00:00:00Z")
    : new Date(now.getTime() - DEFAULT_DAYS * 86400_000);
  // A junk ?from/?to yields an Invalid Date: every NaN comparison is
  // false, so the MAX_DAYS clamp silently disengages and the first
  // `.toISOString()` downstream throws a RangeError (500 for a typo'd
  // date). Fall back to the defaults instead — same guard the email
  // endpoint applies to its own date inputs.
  if (Number.isNaN(to.getTime())) to = now;
  if (Number.isNaN(from.getTime())) {
    from = new Date(to.getTime() - DEFAULT_DAYS * 86400_000);
  }
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

// Delegates to the shared helper for formula-injection
// neutralisation + `\r`-line-ending detection. tracking_number,
// tracking_carrier, and delivery_error flow from carrier APIs and
// aren't fully system-controlled.
function escapeCsv(v: unknown): string {
  return safeCsvCell(v);
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

async function fetchReturns(from: Date, to: Date): Promise<ReturnRow[]> {
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

// ─────────────────────────────────────────────────────────────────
// CSV writers
// ─────────────────────────────────────────────────────────────────

function writeOrdersCsv(
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
      customerKey: customerKeyForId(r.customer_id),
    }));
}

// ─────────────────────────────────────────────────────────────────
// Insurance claims — data fetcher + format helpers.
//
// PHI posture: `patient_id` is HIPAA-protected; we hash it via
// `customerKeyForId` so the export only carries an opaque short
// fingerprint. Free-text columns (`notes`, `denial_reason`) are
// intentionally NOT pulled — they're operator scratch fields that
// commonly include PHI ("patient reports nightly mask leak") and
// have no place in a CSV/PDF that gets emailed around.
// ─────────────────────────────────────────────────────────────────

interface InsuranceClaimRow {
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

async function fetchInsuranceClaims(
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

function writeInsuranceClaimsCsv(
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
function buildQbRowsFromClaims(
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

// ─────────────────────────────────────────────────────────────────
// Patient payments — data fetcher + format helpers.
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
// ─────────────────────────────────────────────────────────────────

interface PatientPaymentRow {
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

async function fetchPatientPayments(
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

function writePatientPaymentsCsv(
  res: import("express").Response,
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
function buildQbRowsFromPatientPayments(
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

// ─────────────────────────────────────────────────────────────────
// All-financial — the one-click "export everything" bundle.
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
// ─────────────────────────────────────────────────────────────────

type CombinedFinancialRow = QuickbooksRowInput & {
  category: string;
  source: string;
};

function buildCombinedFinancialRows(
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

async function fetchCombinedFinancial(
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

function writeCombinedFinancialCsv(
  res: import("express").Response,
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

// ─────────────────────────────────────────────────────────────────
// Customer activity — aggregated, count-only per-day rollup.
//
// PHI/PII posture: we never serialise an individual customer row;
// the export is the COUNT of new signups, the COUNT of orders from
// already-existing customers, and the running active-customer
// count. Even at the storefront tier (where rows aren't HIPAA-
// protected) this keeps the export safe to email and to leave
// open on a screen during a meeting.
// ─────────────────────────────────────────────────────────────────

interface CustomerActivityByDay {
  day: string;
  newCustomers: number;
  returningCustomerOrders: number;
  totalOrders: number;
}

async function fetchCustomerActivity(
  from: Date,
  to: Date,
): Promise<CustomerActivityByDay[]> {
  const supabase = getSupabaseServiceRoleClient();

  // Every order in range. We classify "returning vs new" by
  // comparing the order's created_at against the customer's
  // shop_customers.created_at: same-day == first-order, else
  // returning. This is a slightly conservative classifier — a
  // customer who signs up + orders the same day counts as new,
  // even though they did place an order — but it matches operator
  // intuition for the "new-customer cohort" tile.
  const { data: orders, error: ordersErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("customer_id, created_at")
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .not("customer_id", "is", null)
    .limit(10_000);
  if (ordersErr) throw ordersErr;

  // Collect unique customer IDs from orders in the range.
  const relevantCustomerIds = new Set<string>();
  for (const o of orders ?? []) {
    if (o.customer_id) relevantCustomerIds.add(o.customer_id);
  }

  // Fetch earliest created_at for all customers relevant to this
  // report, regardless of whether they were created within [from,to].
  // This ensures we correctly classify returning customers who signed
  // up before the report period.
  const { data: allCustomers, error: customerErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, created_at")
    .in("customer_id", Array.from(relevantCustomerIds))
    .limit(10_000);
  if (customerErr) throw customerErr;

  const firstSeenByCustomer = new Map<string, string>();
  for (const c of allCustomers ?? []) {
    if (c.customer_id) firstSeenByCustomer.set(c.customer_id, c.created_at);
  }

  // New signups bucketed by day. shop_customers.created_at is the
  // first time we saw the email — opting in elsewhere (sign-up,
  // first cash-pay checkout) all funnel through the same row, so
  // a count by created_at is a clean "new customers per day".
  const { data: signups, error: signupErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, created_at")
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .limit(10_000);
  if (signupErr) throw signupErr;

  const byDay = new Map<
    string,
    {
      newCustomers: number;
      returningCustomerOrders: number;
      totalOrders: number;
    }
  >();
  function bucket(day: string) {
    let v = byDay.get(day);
    if (!v) {
      v = {
        newCustomers: 0,
        returningCustomerOrders: 0,
        totalOrders: 0,
      };
      byDay.set(day, v);
    }
    return v;
  }

  for (const s of signups ?? []) {
    bucket(s.created_at.slice(0, 10)).newCustomers += 1;
  }
  for (const o of orders ?? []) {
    const day = o.created_at.slice(0, 10);
    const b = bucket(day);
    b.totalOrders += 1;
    const firstSeen = o.customer_id
      ? (firstSeenByCustomer.get(o.customer_id) ?? null)
      : null;
    // If we have no record of the customer's first-seen date OR the
    // first-seen is BEFORE this order's day, this order is from a
    // returning customer. Same-day signup+order counts as new (see
    // the classifier note above).
    if (firstSeen && firstSeen.slice(0, 10) < day) {
      b.returningCustomerOrders += 1;
    }
  }

  return Array.from(byDay.entries())
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function writeCustomerActivityCsv(
  res: import("express").Response,
  rows: CustomerActivityByDay[],
): void {
  const headers = [
    "day",
    "new_customers",
    "returning_customer_orders",
    "total_orders",
  ];
  res.write(headers.join(",") + "\n");
  for (const r of rows) {
    res.write(
      [r.day, r.newCustomers, r.returningCustomerOrders, r.totalOrders]
        .map(escapeCsv)
        .join(",") + "\n",
    );
  }
  res.end();
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
    const iif = await renderIifWithAccounts({
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
    const iif = await renderIifWithAccounts({
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
function totalsFromRevenueRows(rows: RevenueByDay[]): {
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
    const total = rows.reduce((s, r) => s + centsToDollars(r.refund_cents), 0);
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

// ─────────────────────────────────────────────────────────────────
// INSURANCE CLAIMS — CSV / PDF / IIF / QBO CSV
// ─────────────────────────────────────────────────────────────────

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
      practiceName: PRACTICE_NAME,
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
      practiceName: PRACTICE_NAME,
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
      practiceName: PRACTICE_NAME,
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

// ─────────────────────────────────────────────────────────────────
// CUSTOMER ACTIVITY — CSV / PDF only.
//
// No QuickBooks exports here on purpose: this report is a behavioral
// aggregate (signup + order counts per day), not a financial ledger.
// Operators wanting to feed the underlying transactions into
// QuickBooks use the `orders` report — that's where the per-order
// cash receipt lives.
// ─────────────────────────────────────────────────────────────────

router.get(
  "/admin/reports/customer-activity.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const rows = await fetchCustomerActivity(from, to);
    setDownloadHeaders(
      res,
      "text/csv; charset=utf-8",
      `pennpaps-customer-activity-${rangeSlug(from, to)}.csv`,
    );
    writeCustomerActivityCsv(res, rows);
  },
);

router.get(
  "/admin/reports/customer-activity.pdf",
  requirePermission("reports.read"),
  async (req, res) => {
    const { from, to } = parseRange(req);
    const rows = await fetchCustomerActivity(from, to);
    const totals = rows.reduce(
      (acc, r) => ({
        newCustomers: acc.newCustomers + r.newCustomers,
        returningCustomerOrders:
          acc.returningCustomerOrders + r.returningCustomerOrders,
        totalOrders: acc.totalOrders + r.totalOrders,
      }),
      { newCustomers: 0, returningCustomerOrders: 0, totalOrders: 0 },
    );
    const pdf = await renderTablePdf({
      title: "Customer activity",
      range: rangeLabel(from, to),
      practiceName: PRACTICE_NAME,
      columns: [
        { label: "Day", width: 100 },
        { label: "New customers", width: 140, rightAlign: true },
        {
          label: "Returning-customer orders",
          width: 200,
          rightAlign: true,
        },
        { label: "Total orders", width: 130, rightAlign: true },
      ],
      rows: rows.map((r) => [
        r.day,
        String(r.newCustomers),
        String(r.returningCustomerOrders),
        String(r.totalOrders),
      ]),
      summaryLines: [
        `New customers in range: ${totals.newCustomers}`,
        `Orders from returning customers: ${totals.returningCustomerOrders}`,
        `Total orders in range: ${totals.totalOrders}`,
        totals.totalOrders > 0
          ? `Returning-customer share: ${(
              (totals.returningCustomerOrders / totals.totalOrders) *
              100
            ).toFixed(1)}%`
          : "Returning-customer share: n/a (no orders)",
      ],
    });
    setDownloadHeaders(
      res,
      "application/pdf",
      `pennpaps-customer-activity-${rangeSlug(from, to)}.pdf`,
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  },
);

// ─────────────────────────────────────────────────────────────────
// PATIENT PAYMENTS — CSV / PDF / IIF / QBO CSV
// ─────────────────────────────────────────────────────────────────

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
      practiceName: PRACTICE_NAME,
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
      practiceName: PRACTICE_NAME,
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
      practiceName: PRACTICE_NAME,
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

// ─────────────────────────────────────────────────────────────────
// ALL-FINANCIAL — the one-click "export everything" bundle.
// CSV / PDF / IIF / QBO CSV, each a single file unioning every
// cash-bearing row in the range. This is the report the task asks
// for: "export ALL financial data into QuickBooks easily" — one
// download per QuickBooks edition, not four.
// ─────────────────────────────────────────────────────────────────

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
      practiceName: PRACTICE_NAME,
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
      practiceName: PRACTICE_NAME,
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
      practiceName: PRACTICE_NAME,
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

// ─────────────────────────────────────────────────────────────────
// Buffered-response shim for the email endpoint.
//
// The existing CSV writers (writeOrdersCsv, etc.) stream directly to
// the express Response via .write() / .end(). For the email-a-report
// flow we need the same bytes as a Buffer so we can attach them to a
// SendGrid message. Rather than parameterise every writer, we hand
// them this tiny shim — it has the only two methods they call.
//
// Any future writer that reaches for additional Response methods
// (.setHeader, .status, etc.) will fail the .csv buffered path; we
// keep the surface intentionally small so an accidental extension
// surfaces as a build error instead of a silent broken email.
// ─────────────────────────────────────────────────────────────────

interface BufferedRes {
  write(chunk: string): boolean;
  end(): void;
}

function bufferedRes(): {
  res: BufferedRes;
  collect: () => Buffer;
} {
  const chunks: Buffer[] = [];
  return {
    res: {
      write(chunk: string) {
        chunks.push(Buffer.from(chunk, "utf8"));
        return true;
      },
      end() {
        // No-op: the caller pulls the bytes via collect().
      },
    },
    collect: () => Buffer.concat(chunks),
  };
}

// ─────────────────────────────────────────────────────────────────
// POST /admin/reports/email — email a generated report.
//
// Accepts { slug, format, from, to, recipient }, generates the
// requested report server-side, and attaches it to a SendGrid
// message. Returns 202 Accepted on enqueue success; the SendGrid
// call is synchronous (no background worker) so a 200/202 means
// the API has handed the message to SendGrid for delivery.
//
// Permissions: reports.read (same as the GET endpoints).
// Rate limit: bulk preset (the underlying SendGrid call is the
// expensive one; per-admin throttling here is a courtesy, not a
// hard guarantee).
// Audit: every send writes a `report.emailed` row carrying the
// slug, format, range, and recipient — no PHI (slugs/formats/dates
// are operational; the recipient is the admin-supplied email).
// ─────────────────────────────────────────────────────────────────

const REPORT_SLUGS = [
  "orders",
  "returns",
  "revenue-summary",
  "refunds-journal",
  "insurance-claims",
  "patient-payments",
  "all-financial",
  "customer-activity",
] as const;
type ReportSlug = (typeof REPORT_SLUGS)[number];

const REPORT_FORMATS = ["csv", "pdf", "iif", "qbo.csv"] as const;
type ReportFormat = (typeof REPORT_FORMATS)[number];

const emailReportBody = z
  .object({
    slug: z.enum(REPORT_SLUGS),
    format: z.enum(REPORT_FORMATS),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    recipient: z.string().email(),
    // Optional admin-supplied note — included verbatim in the email
    // body so the operator can prepend context ("for the April
    // close — please file with this month's receipts").
    note: z.string().trim().max(500).optional(),
  })
  .strict();

// Builds the bytes for a given (slug, format) combination. Returns
// the raw report Buffer + MIME type + filename slug, ready to hand
// to SendGrid as an attachment.
async function buildReportArtifact(
  slug: ReportSlug,
  format: ReportFormat,
  from: Date,
  to: Date,
): Promise<{ buffer: Buffer; contentType: string; filenameExt: string }> {
  // CSV path — every slug supports CSV. Reuse the existing
  // streaming writers via the buffered-response shim.
  if (format === "csv") {
    const { res, collect } = bufferedRes();
    if (slug === "orders") {
      writeOrdersCsv(
        res as unknown as import("express").Response,
        await fetchOrders(from, to),
      );
    } else if (slug === "returns") {
      writeReturnsCsv(
        res as unknown as import("express").Response,
        await fetchReturns(from, to),
      );
    } else if (slug === "revenue-summary") {
      const [orders, returns] = await Promise.all([
        fetchOrders(from, to),
        fetchReturns(from, to),
      ]);
      writeRevenueCsv(
        res as unknown as import("express").Response,
        rollupRevenue(orders, returns),
      );
    } else if (slug === "refunds-journal") {
      writeRefundsCsv(
        res as unknown as import("express").Response,
        await fetchReturns(from, to),
      );
    } else if (slug === "insurance-claims") {
      writeInsuranceClaimsCsv(
        res as unknown as import("express").Response,
        await fetchInsuranceClaims(from, to),
      );
    } else if (slug === "patient-payments") {
      writePatientPaymentsCsv(
        res as unknown as import("express").Response,
        await fetchPatientPayments(from, to),
      );
    } else if (slug === "all-financial") {
      writeCombinedFinancialCsv(
        res as unknown as import("express").Response,
        await fetchCombinedFinancial(from, to),
      );
    } else if (slug === "customer-activity") {
      writeCustomerActivityCsv(
        res as unknown as import("express").Response,
        await fetchCustomerActivity(from, to),
      );
    }
    return {
      buffer: collect(),
      contentType: "text/csv; charset=utf-8",
      filenameExt: "csv",
    };
  }

  // PDF — reuse the per-report PDF render helpers we already
  // invoke from the GET handlers. Each branch returns the rendered
  // buffer directly so we don't pay the cost of going through HTTP.
  if (format === "pdf") {
    if (slug === "orders") {
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
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
    // The other PDFs are simpler — each slug below pulls its data
    // and hands it to renderTablePdf with a slug-specific column
    // shape. We duplicate the GET handlers' shape rather than
    // factor a shared builder because the column widths + summary
    // copy are tuned per-report.
    //
    // (The duplication is intentional and small; a future
    // refactor that bundles per-report builders into a registry
    // would land on the GET path too.)
    if (slug === "returns") {
      const rows = await fetchReturns(from, to);
      const refunded = rows.reduce(
        (s, r) => s + (r.refund_cents ?? 0) / 100,
        0,
      );
      const pdf = await renderTablePdf({
        title: "Returns & RMAs",
        range: rangeLabel(from, to),
        practiceName: PRACTICE_NAME,
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
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
    if (slug === "revenue-summary") {
      const [orders, returns] = await Promise.all([
        fetchOrders(from, to),
        fetchReturns(from, to),
      ]);
      const rows = rollupRevenue(orders, returns);
      const totals = totalsFromRevenueRows(rows);
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
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
    if (slug === "refunds-journal") {
      const allReturns = await fetchReturns(from, to);
      const rows = allReturns.filter(
        (r) => r.refund_cents != null && r.refund_cents > 0,
      );
      const totalUsd = rows.reduce(
        (s, r) => s + (r.refund_cents ?? 0) / 100,
        0,
      );
      const pdf = await renderTablePdf({
        title: "Refunds journal",
        range: rangeLabel(from, to),
        practiceName: PRACTICE_NAME,
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
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
    if (slug === "insurance-claims") {
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
        practiceName: PRACTICE_NAME,
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
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
    if (slug === "customer-activity") {
      const rows = await fetchCustomerActivity(from, to);
      const totals = rows.reduce(
        (acc, r) => ({
          newCustomers: acc.newCustomers + r.newCustomers,
          returningCustomerOrders:
            acc.returningCustomerOrders + r.returningCustomerOrders,
          totalOrders: acc.totalOrders + r.totalOrders,
        }),
        { newCustomers: 0, returningCustomerOrders: 0, totalOrders: 0 },
      );
      const pdf = await renderTablePdf({
        title: "Customer activity",
        range: rangeLabel(from, to),
        practiceName: PRACTICE_NAME,
        columns: [
          { label: "Day", width: 100 },
          { label: "New customers", width: 140, rightAlign: true },
          {
            label: "Returning-customer orders",
            width: 200,
            rightAlign: true,
          },
          { label: "Total orders", width: 130, rightAlign: true },
        ],
        rows: rows.map((r) => [
          r.day,
          String(r.newCustomers),
          String(r.returningCustomerOrders),
          String(r.totalOrders),
        ]),
        summaryLines: [
          `New customers in range: ${totals.newCustomers}`,
          `Orders from returning customers: ${totals.returningCustomerOrders}`,
          `Total orders in range: ${totals.totalOrders}`,
          totals.totalOrders > 0
            ? `Returning-customer share: ${(
                (totals.returningCustomerOrders / totals.totalOrders) *
                100
              ).toFixed(1)}%`
            : "Returning-customer share: n/a (no orders)",
        ],
      });
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
    if (slug === "patient-payments") {
      const rows = await fetchPatientPayments(from, to);
      const collected = rows
        .filter((p) => p.status === "succeeded")
        .reduce((s, p) => s + centsToDollars(p.amount_cents), 0);
      const pdf = await renderTablePdf({
        title: "Patient payments",
        range: rangeLabel(from, to),
        practiceName: PRACTICE_NAME,
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
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
    if (slug === "all-financial") {
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
        practiceName: PRACTICE_NAME,
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
      return {
        buffer: pdf,
        contentType: "application/pdf",
        filenameExt: "pdf",
      };
    }
  }

  // IIF / QBO-CSV — the orders / returns / insurance-claims /
  // patient-payments / all-financial slugs have QuickBooks exports.
  // Other slugs reject before reaching here (the zod enum allows them
  // but we explicitly 400 below).
  if (format === "iif" || format === "qbo.csv") {
    let rows: QuickbooksRowInput[];
    if (slug === "orders") {
      rows = buildQbRowsFromOrders(await fetchOrders(from, to));
    } else if (slug === "returns") {
      rows = buildQbRowsFromReturns(await fetchReturns(from, to));
    } else if (slug === "insurance-claims") {
      rows = buildQbRowsFromClaims(await fetchInsuranceClaims(from, to));
    } else if (slug === "patient-payments") {
      rows = buildQbRowsFromPatientPayments(
        await fetchPatientPayments(from, to),
      );
    } else if (slug === "all-financial") {
      rows = await fetchCombinedFinancial(from, to);
    } else {
      throw new ReportEmailValidationError(
        `${slug} does not support QuickBooks export`,
      );
    }
    const fromIso = from.toISOString().slice(0, 10);
    const toIso = to.toISOString().slice(0, 10);
    if (format === "iif") {
      const iif = await renderIifWithAccounts({
        from: fromIso,
        to: toIso,
        practiceName: PRACTICE_NAME,
        rows,
      });
      return {
        buffer: Buffer.from(iif, "utf8"),
        contentType: "application/octet-stream",
        filenameExt: "iif",
      };
    }
    const csv = renderQboCsv({
      from: fromIso,
      to: toIso,
      practiceName: PRACTICE_NAME,
      rows,
    });
    return {
      buffer: Buffer.from(csv, "utf8"),
      contentType: "text/csv; charset=utf-8",
      filenameExt: "qbo.csv",
    };
  }

  // Should be unreachable — zod validates format above.
  throw new ReportEmailValidationError(`Unsupported format ${format}`);
}

class ReportEmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportEmailValidationError";
  }
}

router.post(
  "/admin/reports/email",
  requirePermission("reports.read"),
  adminRateLimit({ name: "reports.email", preset: "bulk" }),
  async (req, res) => {
    const parsed = emailReportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { slug, format, recipient, note } = parsed.data;
    const from = new Date(parsed.data.from + "T00:00:00Z");
    const to = new Date(parsed.data.to + "T23:59:59Z");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    if (from.getTime() > to.getTime()) {
      res.status(400).json({ error: "from_after_to" });
      return;
    }

    // Cap at MAX_DAYS so a typo of "from=2020" can't fan out to a
    // hundred-day attachment. Matches the GET-side clamp; the
    // operator who needs a longer slice chunks like everywhere
    // else.
    const days = (to.getTime() - from.getTime()) / 86400_000;
    const effectiveTo =
      days > MAX_DAYS ? new Date(from.getTime() + MAX_DAYS * 86400_000) : to;

    let artifact;
    try {
      artifact = await buildReportArtifact(slug, format, from, effectiveTo);
    } catch (err) {
      if (err instanceof ReportEmailValidationError) {
        res.status(400).json({
          error: "format_not_supported",
          message: err.message,
        });
        return;
      }
      throw err;
    }

    let sgClient;
    try {
      sgClient = createSendgridClient();
    } catch (err) {
      if (err instanceof EmailConfigError) {
        res.status(503).json({
          error: "email_not_configured",
          message:
            "Email delivery is not configured on this environment (SENDGRID_API_KEY missing).",
        });
        return;
      }
      throw err;
    }

    const filename = `pennpaps-${slug}-${rangeSlug(from, effectiveTo)}.${artifact.filenameExt}`;
    const subject = `[${PRACTICE_NAME}] ${slug} report — ${rangeLabel(from, effectiveTo)}`;
    const notePara = note ? `<p>${escapeHtml(note)}</p>` : "";
    const html = [
      `<p>Hi,</p>`,
      `<p>Attached is the <strong>${escapeHtml(slug)}</strong> report for the period <strong>${escapeHtml(rangeLabel(from, effectiveTo))}</strong>, generated as <strong>${escapeHtml(format)}</strong>.</p>`,
      notePara,
      `<p>Requested by ${escapeHtml(req.adminEmail ?? "an admin")}.</p>`,
      `<p>— ${escapeHtml(PRACTICE_NAME)}</p>`,
    ]
      .filter(Boolean)
      .join("\n");
    const text = [
      `Hi,`,
      ``,
      `Attached is the ${slug} report for ${rangeLabel(from, effectiveTo)}, generated as ${format}.`,
      ...(note ? ["", note] : []),
      ``,
      `Requested by ${req.adminEmail ?? "an admin"}.`,
      ``,
      `— ${PRACTICE_NAME}`,
    ].join("\n");

    try {
      await sgClient.sendEmail({
        to: recipient,
        subject,
        html,
        text,
        attachments: [
          {
            content: artifact.buffer,
            filename,
            contentType: artifact.contentType,
          },
        ],
      });
    } catch (err) {
      if (err instanceof EmailApiError) {
        logger.warn(
          {
            event: "report_email_send_failed",
            slug,
            format,
            recipient,
            sgStatus: err.status ?? null,
          },
          "Report email send failed at SendGrid",
        );
        res.status(502).json({
          error: "email_send_failed",
          message: "SendGrid rejected the message.",
        });
        return;
      }
      throw err;
    }

    await logAudit({
      action: "report.emailed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "reports",
      targetId: slug,
      metadata: {
        slug,
        format,
        from: parsed.data.from,
        to: parsed.data.to,
        clamped_to: effectiveTo.toISOString().slice(0, 10),
        recipient,
        byteLength: artifact.buffer.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "report.emailed audit write failed");
    });

    res.status(202).json({
      status: "queued",
      slug,
      format,
      recipient,
      bytes: artifact.buffer.length,
    });
  },
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Suppress the unused-import warning when there are no logger calls
// — kept around because future feature-flag-aware behavior here
// would log.
void logger;

export default router;
