// /admin/reports — expansive reporting surface for ops + finance.
//
// Each report has up to four downloadable formats:
//
//   * CSV          — operational, full-fidelity dump (every column)
//   * PDF          — printable summary for filing / sharing
//   * QuickBooks   — IIF (QuickBooks Desktop / Enterprise) + a QBO-
//                    friendly CSV with the column headers QuickBooks
//                    Online recognizes on import
//
// All downloads ride the same /admin/reports/<name>.<ext> endpoint
// with the active date range as query params; the browser handles
// the file save via <a download>. Auth follows the pf_session cookie
// automatically.

import { useState } from "react";

const DEFAULT_DAYS_BACK = 30;
const MAX_DAYS = 90;

interface ReportDefinition {
  /** Slug used in the URL: /admin/reports/<slug>.csv etc. */
  slug: string;
  title: string;
  subtitle: string;
  /** Which formats this report supports. CSV + PDF are mandatory;
   *  QuickBooks formats are only on the finance-transaction reports. */
  formats: ReadonlyArray<"csv" | "pdf" | "iif" | "qbo">;
}

const REPORTS: ReadonlyArray<ReportDefinition> = [
  {
    slug: "orders",
    title: "Cash-pay orders",
    subtitle:
      "Stripe checkout sessions in the date range, including payment and shipping state.",
    formats: ["csv", "pdf", "iif", "qbo"],
  },
  {
    slug: "returns",
    title: "Returns & RMAs",
    subtitle:
      "Comfort-guarantee returns initiated in the date range, with resolution and refund details.",
    formats: ["csv", "pdf", "iif", "qbo"],
  },
  {
    slug: "revenue-summary",
    title: "Revenue summary",
    subtitle:
      "Per-day rollup of gross sales, refunds, and net revenue across the storefront.",
    formats: ["csv", "pdf"],
  },
  {
    slug: "refunds-journal",
    title: "Refunds journal",
    subtitle:
      "Chronological refund ledger — useful for AR reconciliation against Stripe payouts.",
    formats: ["csv", "pdf"],
  },
];

const FORMAT_LABELS: Record<"csv" | "pdf" | "iif" | "qbo", string> = {
  csv: "CSV",
  pdf: "PDF",
  iif: "QuickBooks Desktop (.iif)",
  qbo: "QuickBooks Online (.csv)",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const f = new Date(fromIso).getTime();
  const t = new Date(toIso).getTime();
  return Math.round((t - f) / 86400_000);
}

function reportUrl(
  slug: string,
  format: "csv" | "pdf" | "iif" | "qbo",
  from: string,
  to: string,
): string {
  const params = new URLSearchParams({ from, to }).toString();
  const ext = format === "qbo" ? "qbo.csv" : format;
  return `/resupply-api/admin/reports/${slug}.${ext}?${params}`;
}

export function AdminReportsPage() {
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - DEFAULT_DAYS_BACK * 86400_000);
  const [from, setFrom] = useState(isoDate(defaultFrom));
  const [to, setTo] = useState(isoDate(today));

  const days = diffDays(from, to);
  const clamped = days > MAX_DAYS;

  return (
    <div className="space-y-6 max-w-5xl" data-testid="admin-reports-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Reports
        </h1>
        <p className="text-sm text-slate-600">
          Expansive operational + finance exports. Pick a date range
          (max 90 days per export) and choose a format. PDF is best for
          archival; CSV is best for spreadsheets; the QuickBooks formats
          plug directly into Desktop (.iif) or Online (.csv).
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              From
            </label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              max={to}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              data-testid="reports-from"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              To
            </label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              min={from}
              max={isoDate(today)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              data-testid="reports-to"
            />
          </div>
          <div className="ml-auto text-xs text-slate-500">
            Range: {days} day{days === 1 ? "" : "s"}
            {clamped && (
              <span className="ml-2 text-amber-700">
                (server caps at {MAX_DAYS} days)
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <ReportCard key={r.slug} report={r} from={from} to={to} />
        ))}
      </section>
    </div>
  );
}

function ReportCard({
  report,
  from,
  to,
}: {
  report: ReportDefinition;
  from: string;
  to: string;
}) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-4 space-y-3"
      data-testid={`report-card-${report.slug}`}
    >
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{report.title}</h3>
        <p className="text-xs text-slate-600 mt-0.5">{report.subtitle}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {report.formats.map((format) => (
          <a
            key={format}
            href={reportUrl(report.slug, format, from, to)}
            download
            className={[
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-semibold text-white transition-colors",
              format === "csv"
                ? "bg-blue-600 hover:bg-blue-700"
                : format === "pdf"
                  ? "bg-slate-700 hover:bg-slate-800"
                  : "bg-emerald-700 hover:bg-emerald-800",
            ].join(" ")}
            data-testid={`report-${report.slug}-${format}`}
          >
            {FORMAT_LABELS[format]}
          </a>
        ))}
      </div>
    </div>
  );
}
