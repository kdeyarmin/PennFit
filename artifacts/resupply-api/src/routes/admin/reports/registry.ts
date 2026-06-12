// reports/registry.ts — the slug → module map for /admin/reports/*.
// The Record is keyed by ReportSlug, so adding a slug to REPORT_SLUGS
// without a matching module (or vice versa) is a compile error — the
// catalog and the registry can't drift apart.

import { allFinancialReport } from "./all-financial";
import { customerActivityReport } from "./customer-activity";
import { insuranceClaimsReport } from "./insurance-claims";
import { ordersReport } from "./orders";
import { patientPaymentsReport } from "./patient-payments";
import { refundsJournalReport } from "./refunds-journal";
import { returnsReport } from "./returns";
import { revenueSummaryReport } from "./revenue-summary";
import type { ReportModule, ReportSlug } from "./shared";

export const REPORT_MODULES: Record<ReportSlug, ReportModule> = {
  orders: ordersReport,
  returns: returnsReport,
  "revenue-summary": revenueSummaryReport,
  "refunds-journal": refundsJournalReport,
  "insurance-claims": insuranceClaimsReport,
  "patient-payments": patientPaymentsReport,
  "all-financial": allFinancialReport,
  "customer-activity": customerActivityReport,
};

// GET-route registration order (kept identical to the historical
// single-file layout; paths are disjoint so order is cosmetic, but
// there's no reason to shuffle it).
export const ORDERED_REPORT_MODULES: readonly ReportModule[] = [
  ordersReport,
  returnsReport,
  revenueSummaryReport,
  refundsJournalReport,
  insuranceClaimsReport,
  customerActivityReport,
  patientPaymentsReport,
  allFinancialReport,
];
