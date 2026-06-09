// /admin/pacware — PacWare (legacy DME billing) file-exchange console.
//
// PacWare is a Windows client-server billing package with no network API,
// so the integration is a CSV file exchange:
//   * Import — upload a PacWare Patient List report; the server parses,
//     validates, and syncs patients on the PacWare account number.
//   * Export — download CSVs shaped for PacWare's import screens (the
//     patient roster, and the resupply-due worklist for order entry).
//
// The column reference shown here is served live from the API (which
// reads the shared package catalog), so it can never drift from what the
// parser actually accepts. Full step-by-step instructions:
// docs/runbooks/pacware-import-export.md.

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  Boxes,
  Download,
  FileSpreadsheet,
  Upload,
  TriangleAlert,
  CheckCircle2,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  getPacwareStatus,
  importPacwarePatients,
  type PacwareImportCommit,
  type PacwareImportPreview,
  type PacwareReport,
  type PacwareStatus,
} from "@/lib/admin/pacware-api";

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
          Import patient reports below, and export PennFit data shaped for
          PacWare&apos;s import screens. Step-by-step instructions live in{" "}
          <code className="text-xs">
            docs/runbooks/pacware-import-export.md
          </code>
          .
        </p>
      </header>

      <ImportCard />
      <ExportCard />

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
        account number and synced (new patients are created, existing ones are
        updated). Only the columns your report contains are touched.
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
        Synced {commit.synced} patient{commit.synced === 1 ? "" : "s"}.
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
// Export
// ---------------------------------------------------------------------------
const RESUPPLY_STATUSES = [
  "confirmed",
  "approved",
  "pending",
  "outreach_pending",
] as const;

function ExportCard() {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resupplyStatus, setResupplyStatus] =
    useState<(typeof RESUPPLY_STATUSES)[number]>("confirmed");

  async function download(path: string, filename: string, key: string) {
    setErr(null);
    setBusy(key);
    try {
      const url = new URL(`/resupply-api${path}`, window.location.origin);
      const res = await fetch(url.toString(), {
        headers: { Accept: "text/csv" },
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "Your session expired. Please refresh and try again."
            : `Export failed (${res.status}).`,
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
      if (truncated) {
        setErr(
          "Export was capped at 5,000 rows. Narrow the filter for the rest.",
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Card>
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Download className="h-5 w-5" /> Export for PacWare
      </h2>
      <p className="text-sm mt-1 mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        Download CSVs to import into PacWare. The roster round-trips with the
        importer above; the resupply-due worklist is one line per item for
        PacWare order entry &amp; billing.
      </p>

      {err && (
        <div
          className="mb-3 rounded-lg border px-3 py-2 text-sm"
          style={{
            borderColor: "hsl(0,84%,45%)",
            color: "hsl(0,84%,45%)",
            backgroundColor: "rgba(239,68,68,0.08)",
          }}
        >
          {err}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() =>
            download(
              "/admin/pacware/export/patients.csv",
              `pacware-patient-roster-${today}.csv`,
              "roster",
            )
          }
          disabled={busy !== null}
          isLoading={busy === "roster"}
        >
          <Download className="h-4 w-4" /> Patient roster
        </Button>

        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              download(
                `/admin/pacware/export/resupply-due.csv?status=${resupplyStatus}`,
                `pacware-resupply-due-${resupplyStatus}-${today}.csv`,
                "resupply",
              )
            }
            disabled={busy !== null}
            isLoading={busy === "resupply"}
          >
            <Download className="h-4 w-4" /> Resupply due
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
    </Card>
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
