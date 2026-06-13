// /admin/pacware — PacWare (legacy DME billing) file-exchange console.
//
// PacWare is a Windows client-server billing package with no network API,
// so the integration is a CSV file exchange:
//   * Import — upload a PacWare Patient List report; the server parses,
//     validates, and FILL-syncs patients on the PacWare account number
//     (existing values are never overwritten — only blanks are filled).
//   * Sync to PacWare — verify exactly what will be sent (count + sample),
//     then download a CSV shaped for PacWare's import screens (the patient
//     roster, and the resupply-due worklist for order entry).
//   * Automatic notices — an opt-in toggle so the page proactively shows a
//     "ready to sync" banner. PacWare has no API, so nothing is ever sent
//     automatically; an admin always verifies + downloads.
//
// The column reference shown here is served live from the API (which
// reads the shared package catalog), so it can never drift from what the
// parser actually accepts. Full step-by-step instructions:
// docs/runbooks/pacware-import-export.md.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  Bell,
  Boxes,
  Download,
  FileSpreadsheet,
  Upload,
  TriangleAlert,
  CheckCircle2,
  X,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  getPacwareStatus,
  getPacwareSettings,
  getPacwareSyncPreview,
  importPacwarePatients,
  setPacwareAutoSync,
  type PacwareImportCommit,
  type PacwareImportPreview,
  type PacwareReport,
  type PacwareStatus,
  type PacwareSyncTarget,
} from "@/lib/admin/pacware-api";
import { todayAppDateIso } from "@/lib/utils";

const statusKey = ["admin", "pacware", "status"] as const;

export function AdminPacwarePage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: statusKey,
    queryFn: getPacwareStatus,
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Boxes className="h-6 w-6" /> PacWare data exchange
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          PacWare has no API, so PennFit exchanges data with it as CSV files.
          Import patient reports (a <strong>fill-only sync</strong> that never
          overwrites existing values), and sync PennFit data to PacWare after
          verifying exactly what will be sent. Step-by-step instructions live in{" "}
          <code className="text-xs">
            docs/runbooks/pacware-import-export.md
          </code>
          .
        </p>
      </header>

      <HowToCard />
      <ImportCard />
      <SyncCard />

      <Card>
        <h2 className="text-lg font-semibold mb-1">Column reference</h2>
        <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
          The exact columns each exchange uses. Imports accept the listed header
          plus common aliases (case- and spacing-insensitive).
        </p>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : (
          <StatusBody status={data} />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// How-to (condensed from docs/runbooks/pacware-import-export.md so the
// steps are readable where the work happens; the runbook stays the
// authoritative long-form manual)
// ---------------------------------------------------------------------------
function HowToCard() {
  const muted = { color: "hsl(var(--ink-3))" } as const;
  return (
    <Card>
      <details>
        <summary className="cursor-pointer select-none text-lg font-semibold">
          How to run a sync (step by step)
        </summary>
        <div className="mt-3 grid gap-6 md:grid-cols-2 text-sm">
          <div>
            <h3 className="font-semibold mb-1">
              Import: PacWare → PennFit (patients)
            </h3>
            <ol className="list-decimal pl-5 space-y-1" style={muted}>
              <li>
                In PacWare, run the <strong>Patient List</strong> report and
                export it as CSV.
              </li>
              <li>
                Check the headers against the Column reference below — dates as
                YYYY-MM-DD, phones with area code. Common header aliases are
                accepted.
              </li>
              <li>
                Upload it under <strong>Import patient roster</strong>, review
                the preview (created / updated / unchanged), then commit. Up to
                5,000 rows per upload.
              </li>
              <li>
                Re-running is safe: rows match on{" "}
                <code className="text-xs">pacware_id</code> and the sync is
                fill-only — existing PennFit values are never overwritten.
              </li>
            </ol>
          </div>
          <div>
            <h3 className="font-semibold mb-1">
              Export: PennFit → PacWare (roster / resupply-due)
            </h3>
            <ol className="list-decimal pl-5 space-y-1" style={muted}>
              <li>
                Pick the export under <strong>Sync to PacWare</strong> — patient
                roster or the resupply-due worklist.
              </li>
              <li>
                Always run <strong>Verify</strong> first to preview the row
                count and a sample of exactly what will be sent.
              </li>
              <li>
                Download the CSV and import it in PacWare. Values are
                formula-injection-guarded and round-trip losslessly.
              </li>
              <li>
                Nothing is ever pushed automatically — PacWare has no API, so
                every sync is a deliberate, verified file exchange.
              </li>
            </ol>
          </div>
        </div>
        <p className="mt-4 text-xs" style={muted}>
          Full manual with column mapping and troubleshooting:{" "}
          <code className="text-xs">
            docs/runbooks/pacware-import-export.md
          </code>
        </p>
      </details>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
function ImportCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PacwareImportPreview | null>(null);
  const [commit, setCommit] = useState<PacwareImportCommit | null>(null);

  function reset() {
    setFileName(null);
    setCsv(null);
    setPreview(null);
    setCommit(null);
    setErr(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onPick(file: File) {
    reset();
    setFileName(file.name);
    setBusy(true);
    try {
      const text = await file.text();
      setCsv(text);
      const res = (await importPacwarePatients(
        text,
        "preview",
      )) as PacwareImportPreview;
      setPreview(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not read or parse file.");
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!csv) return;
    setBusy(true);
    setErr(null);
    try {
      const res = (await importPacwarePatients(
        csv,
        "commit",
      )) as PacwareImportCommit;
      setCommit(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Upload className="h-5 w-5" /> Import patient roster
      </h2>
      <p className="text-sm mt-1 mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        In PacWare, run the Patient List / Patient Demographics report and
        export it to CSV. Upload it here — patients are matched on the PacWare
        account number: new patients are created, and for existing patients only{" "}
        <strong>blank</strong> fields are filled in — a value already in PennFit
        is never overwritten.
      </p>

      <div className="flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
          }}
        />
        <Button onClick={() => fileRef.current?.click()} disabled={busy}>
          <FileSpreadsheet className="h-4 w-4" /> Choose CSV file
        </Button>
        {fileName && (
          <span className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            {fileName}
          </span>
        )}
        {(preview || commit || fileName) && (
          <button
            className="text-sm underline"
            style={{ color: "hsl(var(--ink-3))" }}
            onClick={reset}
            disabled={busy}
          >
            Clear
          </button>
        )}
      </div>

      {busy && (
        <div className="mt-3">
          <Spinner />
        </div>
      )}

      {err && (
        <div
          className="mt-3 rounded-lg border px-3 py-2 text-sm"
          style={{
            borderColor: "hsl(0,84%,45%)",
            color: "hsl(0,84%,45%)",
            backgroundColor: "rgba(239,68,68,0.08)",
          }}
        >
          {err}
        </div>
      )}

      {preview && !commit && (
        <PreviewPanel preview={preview} onCommit={onCommit} busy={busy} />
      )}

      {commit && <CommitPanel commit={commit} />}
    </Card>
  );
}

function PreviewPanel({
  preview,
  onCommit,
  busy,
}: {
  preview: PacwareImportPreview;
  onCommit: () => void;
  busy: boolean;
}) {
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <Stat label="Rows in file" value={preview.totalDataRows} />
        <Stat label="Valid" value={preview.validCount} tone="ok" />
        <Stat
          label="Errors"
          value={preview.errorCount}
          tone={preview.errorCount > 0 ? "err" : undefined}
        />
      </div>

      {preview.unmappedHeaders.length > 0 && (
        <div
          className="rounded-lg border px-3 py-2 text-xs"
          style={{
            borderColor: "hsl(38,92%,45%)",
            backgroundColor: "rgba(245,158,11,0.08)",
          }}
        >
          <TriangleAlert className="h-3.5 w-3.5 inline-block mr-1" />
          Ignored columns (not part of the roster layout):{" "}
          <span className="font-mono">
            {preview.unmappedHeaders.join(", ")}
          </span>
        </div>
      )}

      {preview.errors.length > 0 && (
        <div
          className="overflow-auto max-h-56 rounded-lg border"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left" style={{ color: "hsl(var(--ink-3))" }}>
                <th className="px-2 py-1">Row</th>
                <th className="px-2 py-1">Field</th>
                <th className="px-2 py-1">Problem</th>
              </tr>
            </thead>
            <tbody>
              {preview.errors.slice(0, 200).map((e, i) => (
                <tr
                  key={i}
                  className="border-t"
                  style={{ borderColor: "hsl(var(--line-2))" }}
                >
                  <td className="px-2 py-1">{e.rowIndex}</td>
                  <td className="px-2 py-1 font-mono">{e.field ?? "—"}</td>
                  <td className="px-2 py-1">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Button onClick={onCommit} disabled={busy || preview.validCount === 0}>
        <Upload className="h-4 w-4" /> Import {preview.validCount} patient
        {preview.validCount === 1 ? "" : "s"}
      </Button>
      {preview.errorCount > 0 && (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Rows with errors are skipped. Fix them in the source file and
          re-upload to include them.
        </p>
      )}
    </div>
  );
}

function CommitPanel({ commit }: { commit: PacwareImportCommit }) {
  return (
    <div
      className="mt-4 rounded-lg border px-3 py-3 text-sm space-y-1"
      style={{
        borderColor: "hsl(142,72%,29%)",
        backgroundColor: "rgba(16,185,129,0.08)",
      }}
    >
      <div className="flex items-center gap-2 font-semibold">
        <CheckCircle2
          className="h-4 w-4"
          style={{ color: "hsl(142,72%,29%)" }}
        />
        {commit.created} created · {commit.updated} updated (blanks filled) ·{" "}
        {commit.unchanged} unchanged.
      </div>
      <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        Existing values are never overwritten — only empty fields are filled.
      </div>
      {commit.errorCount > 0 && (
        <div style={{ color: "hsl(var(--ink-2))" }}>
          {commit.errorCount} row{commit.errorCount === 1 ? "" : "s"} skipped
          due to validation errors.
        </div>
      )}
      {commit.batchErrors.length > 0 && (
        <ul className="list-disc ml-5" style={{ color: "hsl(0,84%,45%)" }}>
          {commit.batchErrors.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync to PacWare (export direction) — verify, then download.
// ---------------------------------------------------------------------------
const RESUPPLY_STATUSES = [
  "confirmed",
  "approved",
  "pending",
  "outreach_pending",
] as const;

const settingsKey = ["admin", "pacware", "settings"] as const;

// Server-side export cap (mirrors MAX_EXPORT_ROWS in the API route). Used to
// warn the operator BEFORE download when a sync would be truncated.
const SYNC_EXPORT_CAP = 5000;

/** Download the export CSV. Returns true when the server capped the file
 *  (X-Truncated) so the caller can warn that rows were dropped. */
async function downloadCsv(path: string, filename: string): Promise<boolean> {
  const url = new URL(`/resupply-api${path}`, window.location.origin);
  const res = await fetch(url.toString(), {
    headers: { Accept: "text/csv" },
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "Your session expired. Please refresh and try again."
        : `Sync failed (${res.status}).`,
    );
  }
  const truncated = res.headers.get("X-Truncated") === "true";
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  return truncated;
}

function SyncCard() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: settingsKey,
    queryFn: getPacwareSettings,
    refetchOnWindowFocus: true,
  });
  const toggle = useMutation({
    mutationFn: (v: boolean) => setPacwareAutoSync(v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  });
  const [resupplyStatus, setResupplyStatus] =
    useState<(typeof RESUPPLY_STATUSES)[number]>("confirmed");
  const [verify, setVerify] = useState<{
    target: PacwareSyncTarget;
    status?: string;
  } | null>(null);

  const autoSync = settings?.autoSync ?? false;
  const pending = settings?.pending;
  const today = todayAppDateIso();

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Upload className="h-5 w-5" /> Sync to PacWare
          </h2>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Review exactly what will be sent, then download a CSV to import into
            PacWare. The roster round-trips with the importer above; the
            resupply-due worklist is one line per item for order entry &amp;
            billing.
          </p>
        </div>
        <label
          className="flex items-center gap-2 text-sm whitespace-nowrap cursor-pointer"
          title="Automatic: this page shows a 'ready to sync' notice when items are pending. Manual: no proactive notice — sync on demand. PacWare has no API, so nothing is ever sent automatically; you always verify + download."
        >
          <input
            type="checkbox"
            checked={autoSync}
            disabled={toggle.isPending || !settings}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          Automatic notices
        </label>
      </div>

      {autoSync && pending && pending.resupplyDue > 0 && (
        <div
          className="mt-3 rounded-lg border px-3 py-2 text-sm flex items-center gap-2"
          style={{
            borderColor: "hsl(217,91%,45%)",
            backgroundColor: "rgba(59,130,246,0.08)",
          }}
        >
          <Bell className="h-4 w-4" style={{ color: "hsl(217,91%,45%)" }} />
          <span>
            Ready to sync: <strong>{pending.resupplyDue}</strong> confirmed
            resupply order{pending.resupplyDue === 1 ? "" : "s"} waiting. Review
            &amp; download below.
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => setVerify({ target: "patients" })}>
          <Download className="h-4 w-4" /> Sync patient roster
        </Button>
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              setVerify({ target: "resupply-due", status: resupplyStatus })
            }
          >
            <Download className="h-4 w-4" /> Sync resupply due
          </Button>
          <select
            className="text-sm rounded-md border px-2 py-1.5 bg-white"
            style={{ borderColor: "hsl(var(--line-1))" }}
            value={resupplyStatus}
            onChange={(e) =>
              setResupplyStatus(
                e.target.value as (typeof RESUPPLY_STATUSES)[number],
              )
            }
          >
            {RESUPPLY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {verify && (
        <VerifyModal
          target={verify.target}
          status={verify.status}
          onClose={() => setVerify(null)}
          onConfirm={() => {
            const path =
              verify.target === "patients"
                ? "/admin/pacware/export/patients.csv"
                : `/admin/pacware/export/resupply-due.csv?status=${verify.status}`;
            const filename =
              verify.target === "patients"
                ? `pacware-patient-roster-${today}.csv`
                : `pacware-resupply-due-${verify.status}-${today}.csv`;
            return downloadCsv(path, filename);
          }}
        />
      )}
    </Card>
  );
}

function VerifyModal({
  target,
  status,
  onClose,
  onConfirm,
}: {
  target: PacwareSyncTarget;
  status?: string;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "pacware", "preview", target, status ?? ""],
    queryFn: () => getPacwareSyncPreview(target, status),
  });
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const title =
    target === "patients" ? "Sync patient roster" : "Sync resupply due";
  const columns =
    data && data.sample.length > 0 ? Object.keys(data.sample[0]) : [];
  const willTruncate = (data?.count ?? 0) > SYNC_EXPORT_CAP;

  async function confirm() {
    setErr(null);
    setDownloading(true);
    try {
      const truncated = await onConfirm();
      if (truncated) {
        // The file downloaded, but the server capped it. Keep the modal
        // open with a warning rather than silently closing.
        setErr(
          `Downloaded — but capped at ${SYNC_EXPORT_CAP.toLocaleString()} rows. Narrow the filter and sync again for the rest.`,
        );
      } else {
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="admin-root w-full max-w-3xl rounded-lg bg-white shadow-xl max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <h3 className="font-semibold">{title} — verify before sending</h3>
          <button onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {isPending ? (
            <Spinner />
          ) : isError ? (
            <ErrorPanel error={error} onRetry={() => void refetch()} />
          ) : (
            <>
              <p className="text-sm">
                <strong>{data.count}</strong> record
                {data.count === 1 ? "" : "s"} will be synced to PacWare
                {status ? ` (status: ${status})` : ""}. Showing the first{" "}
                {data.sample.length}:
              </p>
              {willTruncate && (
                <div
                  className="rounded-lg border px-3 py-2 text-xs"
                  style={{
                    borderColor: "hsl(38,92%,45%)",
                    backgroundColor: "rgba(245,158,11,0.08)",
                  }}
                >
                  <TriangleAlert className="h-3.5 w-3.5 inline-block mr-1" />
                  The download is capped at {SYNC_EXPORT_CAP.toLocaleString()}{" "}
                  rows — only the first {SYNC_EXPORT_CAP.toLocaleString()} of
                  these {data.count} will be included. Narrow the filter and
                  sync again for the rest.
                </div>
              )}
              {(data.withheldMissingPacwareId ?? 0) > 0 && (
                <div
                  className="rounded-lg border px-3 py-2 text-xs"
                  style={{
                    borderColor: "hsl(38,92%,45%)",
                    backgroundColor: "rgba(245,158,11,0.08)",
                  }}
                >
                  <TriangleAlert className="h-3.5 w-3.5 inline-block mr-1" />
                  <strong>{data.withheldMissingPacwareId}</strong> due item
                  {data.withheldMissingPacwareId === 1 ? " is" : "s are"}{" "}
                  withheld because the patient has no PacWare ID — order entry
                  needs an account number. Open the patient&apos;s page and use{" "}
                  <em>Add</em> next to &ldquo;No PacWare ID&rdquo; in the
                  header, then sync again to include them.
                </div>
              )}
              {data.sample.length === 0 ? (
                <p
                  className="text-sm py-2"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  Nothing to sync right now.
                </p>
              ) : (
                <div
                  className="overflow-auto max-h-80 rounded-lg border"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <table className="w-full text-xs">
                    <thead>
                      <tr
                        className="text-left"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {columns.map((c) => (
                          <th key={c} className="px-2 py-1 whitespace-nowrap">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.sample.map((row, i) => (
                        <tr
                          key={i}
                          className="border-t"
                          style={{ borderColor: "hsl(var(--line-2))" }}
                        >
                          {columns.map((c) => (
                            <td key={c} className="px-2 py-1 whitespace-nowrap">
                              {row[c] === null || row[c] === undefined
                                ? ""
                                : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {err && (
                <div className="text-sm" style={{ color: "hsl(0,84%,45%)" }}>
                  {err}
                </div>
              )}
            </>
          )}
        </div>
        <div
          className="flex items-center justify-end gap-2 px-4 py-3 border-t"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <button
            className="text-sm px-3 py-1.5"
            onClick={onClose}
            disabled={downloading}
          >
            Cancel
          </button>
          <Button
            onClick={confirm}
            disabled={isPending || isError || (data?.count ?? 0) === 0}
            isLoading={downloading}
          >
            <Download className="h-4 w-4" /> Confirm &amp; download CSV
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status / column reference
// ---------------------------------------------------------------------------
function StatusBody({ status }: { status: PacwareStatus }) {
  return (
    <div className="space-y-5">
      <div className="text-sm">
        Exchange status:{" "}
        {status.availability.status === "configured" ? (
          <span style={{ color: "hsl(142,72%,29%)", fontWeight: 600 }}>
            Ready (file exchange)
          </span>
        ) : (
          <span style={{ color: "hsl(0,84%,45%)", fontWeight: 600 }}>
            Disabled — {status.availability.reason}
          </span>
        )}
      </div>
      {status.reports.map((r) => (
        <ReportSpec key={r.kind} report={r} />
      ))}
    </div>
  );
}

function ReportSpec({ report }: { report: PacwareReport }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">
        {report.label}{" "}
        <span
          className="ml-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: "hsl(var(--surface-2))",
            color: "hsl(var(--ink-3))",
          }}
        >
          {report.direction}
        </span>
      </h3>
      <p className="text-xs mb-2" style={{ color: "hsl(var(--ink-3))" }}>
        {report.description}
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left" style={{ color: "hsl(var(--ink-3))" }}>
            <th className="py-1 pr-3">Column</th>
            <th className="py-1 pr-3">Required</th>
            <th className="py-1">Description</th>
          </tr>
        </thead>
        <tbody>
          {report.columns.map((c) => (
            <tr
              key={c.field}
              className="border-t"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <td className="py-1 pr-3 font-mono">{c.header}</td>
              <td className="py-1 pr-3">{c.required ? "yes" : "—"}</td>
              <td className="py-1">{c.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "err";
}) {
  const color =
    tone === "ok"
      ? "hsl(142,72%,29%)"
      : tone === "err"
        ? "hsl(0,84%,45%)"
        : "hsl(var(--ink-1))";
  return (
    <span>
      <span className="font-semibold" style={{ color }}>
        {value}
      </span>{" "}
      <span style={{ color: "hsl(var(--ink-3))" }}>{label}</span>
    </span>
  );
}
