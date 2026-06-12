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
//
// The per-report logic lives in ./reports/<slug>.ts (one module per
// report, dispatched via ./reports/registry.ts); the shared range/
// CSV/IIF helpers live in ./reports/shared.ts; the email-a-report
// endpoint lives in ./reports/email.ts. This file is only the
// router assembly.

import { Router, type IRouter } from "express";

import { registerEmailRoute } from "./reports/email";
import { ORDERED_REPORT_MODULES } from "./reports/registry";

const router: IRouter = Router();

for (const report of ORDERED_REPORT_MODULES) {
  report.register(router);
}

// POST /admin/reports/email — email a generated report.
registerEmailRoute(router);

export default router;
