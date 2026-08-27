// Static metadata for the /admin/reports page.
//
// Split into its own module so the .test.ts under this directory can
// import it from a node-environment test runner (the .tsx file pulls
// in React + JSX which the cpap-fitter vitest config can't compile
// under "node"). Same rationale as ./admin-reports-presets.ts.
//
// What lives here:
//   * FormatKey + ReportDefinition — the type surface used by the
//     page and its tests.
//   * FORMAT_LABELS — display labels for each download format.
//   * REPORTS — the catalog of reports the page renders cards for.
//
// The backend endpoints (artifacts/resupply-api/src/routes/admin/
// reports.ts) are the source of truth for what slugs + formats are
// actually downloadable. This module mirrors that surface. When a
// new report goes live in the API, add its row here so the card
// shows up on the page.

/** Download format identifier. Maps onto the URL extension via
 *  reportUrl() in admin-reports.tsx (qbo → ".qbo.csv", everything
 *  else → "." + key). */
export type FormatKey = "csv" | "pdf" | "iif" | "qbo";

/** A single report card on /admin/reports. */
export interface ReportDefinition {
  /** Path segment used in /resupply-api/admin/reports/<slug>.<ext>.
   *  Must match a route registered in the backend reports router. */
  slug: string;
  /** Short bold heading on the card. */
  title: string;
  /** One-line description under the title. */
  subtitle: string;
  /** Download formats this report exposes. CSV + PDF are mandatory
   *  on every report (operational dump + printable summary); IIF +
   *  QBO are reserved for finance-bearing exports that have a
   *  meaningful QuickBooks shape. */
  formats: readonly FormatKey[];
}

/** Display label for each format button on the card. The IIF + QBO
 *  labels MUST contain "QuickBooks Desktop" / "QuickBooks Online"
 *  respectively — admin-reports.test.ts pins those phrases so the
 *  user can never be left guessing which one to pick for which
 *  QuickBooks edition. */
export const FORMAT_LABELS: Record<FormatKey, string> = {
  csv: "CSV",
  pdf: "PDF",
  iif: "QuickBooks Desktop (.iif)",
  qbo: "QuickBooks Online (.csv)",
};

/** The eight reports the page exposes. Order matches the order the
 *  cards render in (a 2-column grid on >= sm). Adding a row is a
 *  one-line change; removing a row needs the backend route gone first
 *  or the card 404s on click. `all-financial` is intentionally first:
 *  it's the one-click "export everything for QuickBooks" bundle. */
export const REPORTS: readonly ReportDefinition[] = [
  {
    slug: "all-financial",
    title: "All financial data",
    subtitle:
      "Everything in one file: historical shop orders, refunds, insurance (payer) receipts, and patient-responsibility collections for the range. Pick QuickBooks Desktop (.iif) or Online (.csv) and import a single artifact — no chasing four separate downloads.",
    formats: ["csv", "pdf", "iif", "qbo"],
  },
  {
    slug: "orders",
    title: "Orders (historical shop)",
    subtitle:
      "Historical paid shop orders in the range — patient, product, amount, tax, shipping. New patient volume is insurance-only; this export covers legacy cash-pay rows. QuickBooks formats post each order as a Sales Receipt.",
    formats: ["csv", "pdf", "iif", "qbo"],
  },
  {
    slug: "returns",
    title: "Returns",
    subtitle:
      "Refunds + return-shipping reversals on historical shop orders. Mirrors the Orders shape so the two reconcile in QuickBooks against the same customer record.",
    formats: ["csv", "pdf", "iif", "qbo"],
  },
  {
    slug: "revenue-summary",
    title: "Revenue summary",
    subtitle:
      "Top-of-funnel rollup: gross, refunds, net, by product category (historical shop + insurance where available). The PDF supports the optional prior-period comparison panel.",
    formats: ["csv", "pdf"],
  },
  {
    slug: "refunds-journal",
    title: "Refunds journal",
    subtitle:
      "Audit-style line-by-line list of every refund in the range, with the reason code and the original order reference.",
    formats: ["csv", "pdf"],
  },
  {
    slug: "insurance-claims",
    title: "Insurance claims",
    subtitle:
      "Submitted, accepted, paid, and denied claims in the range. The QuickBooks formats post the paid slice as payer cash receipts; patient-responsibility collections live in the Patient payments report.",
    formats: ["csv", "pdf", "iif", "qbo"],
  },
  {
    slug: "patient-payments",
    title: "Patient payments",
    subtitle:
      "Patient-responsibility amounts collected (mail-in check and other recorded collections — not a live card-checkout path). Disjoint from insurance claims, so the two reconcile without double-counting. QuickBooks formats post to a dedicated Patient Payments income account.",
    formats: ["csv", "pdf", "iif", "qbo"],
  },
  {
    slug: "customer-activity",
    title: "Customer activity",
    subtitle:
      "Per-patient summary: historical orders, returns, last contact, lifetime spend. Useful for outreach prep before a CSR call.",
    formats: ["csv", "pdf"],
  },
];
