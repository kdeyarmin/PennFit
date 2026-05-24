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

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createReportPreset,
  deleteReportPreset,
  listReportPresets,
  type ReportPreset,
  type ReportPresetCreate,
} from "@/lib/admin/report-presets-api";

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
              aria-label="From date"
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
              aria-label="To date"
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

      <SavedPresetsSection
        from={from}
        to={to}
        onApply={(p) => {
          if (p.rangeKind === "preset" && p.rangePreset) {
            const preset = DATE_PRESETS.find(
              (entry) => entry.testId === p.rangePreset,
            );
            if (preset) {
              const { from: pf, to: pt } = preset.compute(new Date());
              setFrom(pf);
              setTo(pt);
            }
          } else if (p.rangeFrom && p.rangeTo) {
            setFrom(p.rangeFrom);
            setTo(p.rangeTo);
          }
        }}
      />

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
            aria-label="Format"
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
            aria-label="Recipient email"
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
            aria-label="Note"
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

// ─────────────────────────────────────────────────────────────────
// Saved presets section.
//
// Each preset is a (slug, format, range) tuple the admin saved for
// fast re-apply. Clicking a preset row applies the range to the
// page's date inputs and surfaces a download link for the saved
// (slug, format). Range mode "preset" (e.g. last-month) re-computes
// off `new Date()` each click so "always last month" stays current.
// ─────────────────────────────────────────────────────────────────

const PRESETS_QUERY_KEY = ["admin-report-presets"] as const;

function SavedPresetsSection({
  from,
  to,
  onApply,
}: {
  from: string;
  to: string;
  onApply: (preset: ReportPreset) => void;
}) {
  const query = useQuery({
    queryKey: PRESETS_QUERY_KEY,
    queryFn: listReportPresets,
  });
  const [creating, setCreating] = useState(false);

  return (
    <section
      aria-label="Saved report presets"
      data-testid="reports-saved-presets"
      className="space-y-2"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Saved presets
        </h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          data-testid="reports-presets-new"
        >
          + Save current view
        </button>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white">
        {query.isPending ? (
          <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>
        ) : query.isError ? (
          <p
            className="px-4 py-3 text-sm text-rose-700"
            role="alert"
            data-testid="reports-presets-error"
          >
            Couldn&apos;t load presets:{" "}
            {query.error instanceof Error ? query.error.message : "unknown"}
          </p>
        ) : (query.data?.presets ?? []).length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">
            No saved presets yet. Pick a date range + format above and
            click <strong>+ Save current view</strong> to pin it.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {(query.data?.presets ?? []).map((p) => (
              <SavedPresetRow
                key={p.id}
                preset={p}
                onApply={() => onApply(p)}
              />
            ))}
          </ul>
        )}
      </div>
      {creating && (
        <NewPresetModal
          defaultRange={{ from, to }}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}

function SavedPresetRow({
  preset,
  onApply,
}: {
  preset: ReportPreset;
  onApply: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteReportPreset(preset.id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY }),
  });

  const rangeLabel =
    preset.rangeKind === "preset"
      ? (DATE_PRESETS.find((p) => p.testId === preset.rangePreset)?.label ??
        preset.rangePreset ??
        "preset")
      : `${preset.rangeFrom} → ${preset.rangeTo}`;

  return (
    <li
      className="flex items-center gap-3 px-4 py-2 text-sm"
      data-testid={`preset-row-${preset.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-slate-900 truncate">
          {preset.name}
        </div>
        <div className="text-xs text-slate-600 truncate">
          <code className="rounded bg-slate-100 px-1 font-mono">
            {preset.slug}
          </code>{" "}
          · {preset.format} · {rangeLabel}
          {preset.recipient && (
            <span className="ml-1 text-slate-500">→ {preset.recipient}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onApply}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        data-testid={`preset-row-${preset.id}-apply`}
      >
        Apply range
      </button>
      <button
        type="button"
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
        className="rounded border border-rose-200 bg-white px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
        data-testid={`preset-row-${preset.id}-delete`}
        aria-label={`Delete preset ${preset.name}`}
        title="Delete preset"
      >
        ✕
      </button>
    </li>
  );
}

// Slugs + formats are the same lists used by the page-level
// ReportCard grid; keep this catalog in sync. (A future refactor
// could derive both from one source.)
const PRESET_SLUG_OPTIONS = [
  "orders",
  "returns",
  "revenue-summary",
  "refunds-journal",
  "insurance-claims",
  "customer-activity",
] as const;
// Matches the FORMAT_VALUES enum on the backend (routes/admin/report-presets.ts).
type PresetFormat = "csv" | "pdf" | "iif" | "qbo.csv";

function NewPresetModal({
  defaultRange,
  onClose,
}: {
  defaultRange: { from: string; to: string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] =
    useState<(typeof PRESET_SLUG_OPTIONS)[number]>("orders");
  const [format, setFormat] =
    useState<PresetFormat>("csv");
  // "absolute" pins the dates as-of save; "preset" stores the
  // DATE_PRESETS testId so "always last month" stays current.
  const [rangeMode, setRangeMode] = useState<"absolute" | "preset">(
    "absolute",
  );
  const [rangePreset, setRangePreset] = useState<string>(
    DATE_PRESETS[0]?.testId ?? "",
  );
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const create = useMutation({
    mutationFn: (body: ReportPresetCreate) => createReportPreset(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
      onClose();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    },
  });

  // Allowable formats per slug — mirrors the REPORTS array's
  // formats field. Memoise so the <select> doesn't recompute on
  // every keystroke.
  const allowedFormats = useMemo(() => {
    const r = REPORTS.find((x) => x.slug === slug);
    return (r?.formats ?? []).map((f) =>
      f === "qbo" ? "qbo.csv" : f,
    ) as ReadonlyArray<PresetFormat>;
  }, [slug]);

  const validName = name.trim().length > 0;
  const validRange =
    rangeMode === "absolute"
      ? Boolean(defaultRange.from && defaultRange.to)
      : Boolean(rangePreset);
  const validRecipient =
    recipient.trim().length === 0 || /@/.test(recipient);
  const canSubmit =
    validName && validRange && validRecipient && !create.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-preset-title"
      onClick={onClose}
      data-testid="reports-presets-new-modal"
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl border border-slate-200 p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="new-preset-title" className="text-base font-bold text-slate-900">
          Save current view as preset
        </h3>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Name
          </label>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            aria-label="Preset name"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Monthly close — last month IIF"
            data-testid="reports-presets-new-name"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Report
            </label>
            <select
              value={slug}
              onChange={(e) => {
                const next = e.target.value as typeof slug;
                setSlug(next);
                // Reset the format if the new slug doesn't support
                // the current one (e.g. revenue-summary → can't be
                // iif). Pick the first allowed format.
                const r = REPORTS.find((x) => x.slug === next);
                const allowed = (r?.formats ?? []).map((f) =>
                  f === "qbo" ? "qbo.csv" : f,
                ) as ReadonlyArray<PresetFormat>;
                if (allowed.length > 0 && !allowed.includes(format)) {
                  setFormat(allowed[0]!);
                }
              }}
              aria-label="Report"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              data-testid="reports-presets-new-slug"
            >
              {PRESET_SLUG_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Format
            </label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
              aria-label="Format"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              data-testid="reports-presets-new-format"
            >
              {allowedFormats.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Range
          </label>
          <div className="flex items-center gap-3 text-xs text-slate-700">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={rangeMode === "absolute"}
                onChange={() => setRangeMode("absolute")}
                data-testid="reports-presets-new-range-absolute"
              />
              <span>
                Use current dates ({defaultRange.from} → {defaultRange.to})
              </span>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={rangeMode === "preset"}
                onChange={() => setRangeMode("preset")}
                data-testid="reports-presets-new-range-preset"
              />
              <span>Use a relative preset</span>
            </label>
          </div>
          {rangeMode === "preset" && (
            <select
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value)}
              aria-label="Relative range preset"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              data-testid="reports-presets-new-range-preset-select"
            >
              {DATE_PRESETS.map((p) => (
                <option key={p.testId} value={p.testId}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Default email recipient (optional)
          </label>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="accounting@example.com"
            aria-label="Default email recipient"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            data-testid="reports-presets-new-recipient"
          />
        </div>
        {error && (
          <p
            className="text-xs text-rose-700"
            role="alert"
            data-testid="reports-presets-new-error"
          >
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              setError(null);
              const recipientValue = recipient.trim()
                ? recipient.trim()
                : null;
              const body: ReportPresetCreate =
                rangeMode === "preset"
                  ? {
                      name: name.trim(),
                      slug,
                      format,
                      rangeKind: "preset",
                      rangePreset,
                      recipient: recipientValue,
                    }
                  : {
                      name: name.trim(),
                      slug,
                      format,
                      rangeKind: "absolute",
                      rangeFrom: defaultRange.from,
                      rangeTo: defaultRange.to,
                      recipient: recipientValue,
                    };
              create.mutate(body);
            }}
            className={[
              "rounded px-3 py-1.5 text-sm font-semibold text-white",
              canSubmit
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-blue-300 cursor-not-allowed",
            ].join(" ")}
            data-testid="reports-presets-new-save"
          >
            {create.isPending ? "Saving…" : "Save preset"}
          </button>
        </div>
      </div>
    </div>
  );
}
