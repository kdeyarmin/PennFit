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

import { useEffect, useRef, useState } from "react";

import { DATE_PRESETS, isoDate } from "./admin-reports-presets";
import {
  REPORTS,
  FORMAT_LABELS,
  type FormatKey,
  type ReportDefinition,
} from "./reports-metadata";

const DEFAULT_DAYS_BACK = 30;
const MAX_DAYS = 90;

function diffDays(fromIso: string, toIso: string): number {
  const f = new Date(fromIso).getTime();
  const t = new Date(toIso).getTime();
  return Math.round((t - f) / 86400_000);
}

function reportUrl(
  slug: string,
  format: FormatKey,
  from: string,
  to: string,
  options: { compare?: boolean } = {},
): string {
  const params = new URLSearchParams({ from, to });
  // Only attach ?compare=true when the option is on AND the
  // backend actually supports it for this report (today only the
  // revenue-summary PDF inspects the flag — see reports.ts). We
  // include it unconditionally when set so future reports that
  // opt in pick it up without a UI change.
  if (options.compare) params.set("compare", "true");
  const ext = format === "qbo" ? "qbo.csv" : format;
  return `/resupply-api/admin/reports/${slug}.${ext}?${params.toString()}`;
}

// Date presets live in ./admin-reports-presets so they're
// importable from a .ts test file (vite's import-analysis on JSX
// can't pre-parse a .tsx-only module in a node-environment test
// runner). The re-export above keeps the call sites in this file
// using the same import path.

export function AdminReportsPage() {
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - DEFAULT_DAYS_BACK * 86400_000);
  const [from, setFrom] = useState(isoDate(defaultFrom));
  const [to, setTo] = useState(isoDate(today));
  // Per-page opt-in. When checked, reports that support a prior-
  // period comparison (today only revenue-summary.pdf) include the
  // ?compare=true query param. Other reports ignore it.
  const [compareToPrior, setCompareToPrior] = useState(false);

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

      <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        <div
          className="flex flex-wrap gap-1.5"
          data-testid="reports-date-presets"
        >
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.testId}
              type="button"
              onClick={() => {
                const { from: pf, to: pt } = preset.compute(new Date());
                setFrom(pf);
                setTo(pt);
              }}
              className="rounded border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              data-testid={preset.testId}
            >
              {preset.label}
            </button>
          ))}
        </div>
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
        <div className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            id="reports-compare-to-prior"
            checked={compareToPrior}
            onChange={(e) => setCompareToPrior(e.target.checked)}
            data-testid="reports-compare-checkbox"
            className="h-3.5 w-3.5"
          />
          <label htmlFor="reports-compare-to-prior" className="select-none">
            Compare to previous period of equal length{" "}
            <span className="text-slate-500">
              (revenue summary PDF only — adds delta totals)
            </span>
          </label>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <ReportCard
            key={r.slug}
            report={r}
            from={from}
            to={to}
            compareToPrior={compareToPrior}
          />
        ))}
      </section>
    </div>
  );
}

// Reports that pick up the prior-period comparison when the page-
// level checkbox is checked. The list lives here (not on the
// ReportDefinition) because the comparison is a per-FORMAT trait
// (only the revenue-summary PDF currently renders the delta block)
// and adding it to the definition would imply every format
// supports it.
const COMPARE_AWARE: ReadonlyArray<{
  slug: string;
  format: "csv" | "pdf" | "iif" | "qbo";
}> = [{ slug: "revenue-summary", format: "pdf" }];

function supportsCompare(
  slug: string,
  format: "csv" | "pdf" | "iif" | "qbo",
): boolean {
  return COMPARE_AWARE.some((c) => c.slug === slug && c.format === format);
}

function ReportCard({
  report,
  from,
  to,
  compareToPrior,
}: {
  report: ReportDefinition;
  from: string;
  to: string;
  compareToPrior: boolean;
}) {
  const [emailModalOpen, setEmailModalOpen] = useState(false);
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
        {report.formats.map((format: FormatKey) => {
          const useCompare =
            compareToPrior && supportsCompare(report.slug, format);
          return (
            <a
              key={format}
              href={reportUrl(report.slug, format, from, to, {
                compare: useCompare,
              })}
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
              {useCompare && (
                <span
                  className="ml-1 rounded bg-white/20 px-1 text-[10px] font-bold tracking-wide"
                  data-testid={`report-${report.slug}-${format}-compare-badge`}
                >
                  Δ
                </span>
              )}
            </a>
          );
        })}
        <button
          type="button"
          onClick={() => setEmailModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          data-testid={`report-${report.slug}-email`}
        >
          Email…
        </button>
      </div>
      {emailModalOpen && (
        <EmailReportModal
          report={report}
          from={from}
          to={to}
          compareToPrior={compareToPrior}
          onClose={() => setEmailModalOpen(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Email-this-report modal.
//
// Picks a format (filtered to whatever the report exposes), takes
// a recipient + optional note, and POSTs to
// /admin/reports/email. SendGrid handles the actual delivery; this
// modal only resolves when the API returns 202 / 4xx.
// ─────────────────────────────────────────────────────────────────

interface EmailSendBody {
  slug: string;
  format: "csv" | "pdf" | "iif" | "qbo.csv";
  from: string;
  to: string;
  recipient: string;
  note?: string;
}

async function postReportEmail(body: EmailSendBody): Promise<void> {
  const res = await fetch("/resupply-api/admin/reports/email", {
    credentials: "include",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const json = (await res.json()) as { message?: string; error?: string };
      message = json.message ?? json.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
}

function EmailReportModal({
  report,
  from,
  to,
  compareToPrior: _compareToPrior,
  onClose,
}: {
  report: ReportDefinition;
  from: string;
  to: string;
  compareToPrior: boolean;
  onClose: () => void;
}) {
  // Pre-select the first format the report supports — CSV
  // virtually always wins because every report exposes it.
  const [format, setFormat] = useState<"csv" | "pdf" | "iif" | "qbo">(
    report.formats[0] ?? "csv",
  );
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const recipientRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    recipientRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const canSubmit =
    !submitting && recipient.trim().length > 0 && /@/.test(recipient);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`email-report-title-${report.slug}`}
      onClick={onClose}
      data-testid={`email-report-${report.slug}`}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl border border-slate-200 p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1">
          <h3
            id={`email-report-title-${report.slug}`}
            className="text-base font-bold text-slate-900"
          >
            Email this report
          </h3>
          <p className="text-xs text-slate-600">
            <strong>{report.title}</strong> · {from} → {to}
          </p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Format
          </label>
          <select
            value={format}
            onChange={(e) =>
              setFormat(e.target.value as typeof format)
            }
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            data-testid={`email-report-${report.slug}-format`}
          >
            {report.formats.map((f: FormatKey) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Recipient email
          </label>
          <input
            ref={recipientRef}
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="accounting@example.com"
            data-testid={`email-report-${report.slug}-recipient`}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="For the April close — please file with this month's receipts."
            data-testid={`email-report-${report.slug}-note`}
          />
        </div>
        {error && (
          <p
            className="text-xs text-rose-700"
            role="alert"
            data-testid={`email-report-${report.slug}-error`}
          >
            {error}
          </p>
        )}
        {success && (
          <p
            className="text-xs text-emerald-700"
            data-testid={`email-report-${report.slug}-success`}
          >
            Sent. SendGrid has accepted the message — delivery times
            vary by recipient.
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            data-testid={`email-report-${report.slug}-cancel`}
          >
            Close
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={async () => {
              setSubmitting(true);
              setError(null);
              try {
                await postReportEmail({
                  slug: report.slug,
                  format: format === "qbo" ? "qbo.csv" : format,
                  from,
                  to,
                  recipient: recipient.trim(),
                  note: note.trim() ? note.trim() : undefined,
                });
                setSuccess(true);
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Send failed.",
                );
              } finally {
                setSubmitting(false);
              }
            }}
            className={[
              "rounded px-3 py-1.5 text-sm font-semibold text-white",
              canSubmit
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-blue-300 cursor-not-allowed",
            ].join(" ")}
            data-testid={`email-report-${report.slug}-send`}
          >
            {submitting ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
