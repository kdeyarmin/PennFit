// /admin/billing/era — ERA (5010 835) file upload + history.
//
// Two surfaces in one page:
//   1. Upload — drop an 835 file in, the backend parses it, runs the
//      reconciler, and posts adjudications back to the matched
//      insurance_claims rows. We show the summary (lines, dollars,
//      matched/unmatched count) inline so the operator can confirm.
//   2. History — most-recent 200 ingested files with their status,
//      so an audit/redo workflow has a paper trail.
//
// The body is sent as a plain string (the EDI text) — the backend
// computes SHA-256 server-side and refuses double-applies, so an
// accidental re-upload is safe.

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchEraFiles,
  formatMoneyCents,
  ingestEraFile,
  type EraIngestResponse,
} from "@/lib/admin/billing-api";

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function statusTone(status: string): string {
  // era_files.status is one of: "processed" | "partial" | "rejected"
  // (see lib/resupply-db/drizzle/0118_insurance_claims.sql).
  if (status === "processed") return "#15803d";
  if (status === "partial") return "#b45309";
  if (status === "rejected") return "#b91c1c";
  return "hsl(var(--ink-2))";
}

export function AdminBillingEraPage() {
  const qc = useQueryClient();
  const [lastResult, setLastResult] = useState<EraIngestResponse | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const history = useQuery({
    queryKey: ["admin-billing-era-files"],
    queryFn: fetchEraFiles,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const payload = await file.text();
      return ingestEraFile({ fileName: file.name, payload });
    },
    onSuccess: (res) => {
      setLastResult(res);
      setUploadError(null);
      void qc.invalidateQueries({ queryKey: ["admin-billing-era-files"] });
      void qc.invalidateQueries({
        queryKey: ["admin-billing-director-summary"],
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err) => {
      setLastResult(null);
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    },
  });

  async function onPickFile(file: File | null) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setUploadError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is 4 MB.`,
      );
      // Drop the previous success card so the operator isn't reading
      // stale data under the new error; also reset the file input so
      // the same file can be re-picked after a fix (some browsers
      // suppress the `change` event when the value matches).
      setLastResult(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    upload.mutate(file);
  }

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-era"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          ERA files
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Upload an 835 from your clearinghouse to auto-post payer
          adjudications. The file body is not stored — only the SHA-256 + parser
          summary — so PHI stays out of the DB. A repeat upload of the same file
          is rejected by hash.
        </p>
      </header>

      <Card title="Upload an 835" subtitle="Plain EDI text, up to 4 MB">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".835,.txt,.edi,.dat"
            onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            disabled={upload.isPending}
            className="text-sm"
            data-testid="era-file-input"
          />
          <Button
            intent="primary"
            size="sm"
            disabled={upload.isPending}
            isLoading={upload.isPending}
            onClick={() => fileInputRef.current?.click()}
            data-testid="era-upload-button"
          >
            <Upload className="h-3.5 w-3.5" />
            {upload.isPending ? "Posting…" : "Pick & upload"}
          </Button>
        </div>

        {uploadError && (
          <p
            className="mt-3 text-sm"
            style={{ color: "#b91c1c" }}
            data-testid="era-upload-error"
          >
            {uploadError}
          </p>
        )}

        {lastResult &&
          (() => {
            const s = lastResult.summary;
            // Sum paidCents from per-claim outcomes — the reconciler
            // doesn't return a single totalPaidCents field, so we
            // derive it here for the headline.
            const totalPaidCents = s.outcomes.reduce(
              (acc, o) => acc + (o.paidCents ?? 0),
              0,
            );
            return (
              <div
                className="mt-4 rounded-md border p-3 text-sm space-y-1"
                style={{
                  borderColor: "rgba(21, 128, 61, 0.32)",
                  backgroundColor: "rgba(21, 128, 61, 0.06)",
                  color: "hsl(var(--ink-1))",
                }}
                data-testid="era-upload-result"
              >
                <p>
                  <strong>Posted</strong> — status{" "}
                  <span style={{ color: statusTone(lastResult.status) }}>
                    {lastResult.status}
                  </span>
                  , {s.linesUpdated} line(s) updated.
                </p>
                <p>
                  Posted <strong>{formatMoneyCents(totalPaidCents)}</strong>{" "}
                  across {s.matchedClaims} matched claim(s)
                  {s.paidClaims > 0 && (
                    <>
                      {" "}
                      ({s.paidClaims} paid
                      {s.deniedClaims > 0 ? `, ${s.deniedClaims} denied` : ""})
                    </>
                  )}
                  .
                  {s.unmatchedClaims > 0 && (
                    <>
                      {" "}
                      <span style={{ color: "#b45309" }}>
                        {s.unmatchedClaims} unmatched
                      </span>{" "}
                      need manual link.
                    </>
                  )}
                </p>
              </div>
            );
          })()}
      </Card>

      {history.isError && (
        <ErrorPanel
          error={history.error}
          onRetry={() => void history.refetch()}
        />
      )}

      <Card title="Recent ERA files" subtitle="Last 200 uploads, newest first">
        {history.isPending ? (
          <Spinner label="Loading history…" />
        ) : (history.data?.eraFiles.length ?? 0) === 0 ? (
          <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
            No ERA files ingested yet.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">File</th>
                  <th className="p-3">Payer check #</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Paid</th>
                  <th className="p-3 text-right">Claims paid</th>
                  <th className="p-3 text-right">Claims denied</th>
                  <th className="p-3">Ingested</th>
                </tr>
              </thead>
              <tbody>
                {(history.data?.eraFiles ?? []).map((f) => (
                  <tr
                    key={f.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td
                      className="p-3 font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      <span className="block">{f.fileName}</span>
                      {f.rejectionReason && (
                        <span
                          className="block text-[11px]"
                          style={{ color: "#b91c1c" }}
                        >
                          {f.rejectionReason}
                        </span>
                      )}
                    </td>
                    <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
                      {f.payerCheckNumber ?? "—"}
                    </td>
                    <td
                      className="p-3 font-semibold"
                      style={{ color: statusTone(f.status) }}
                    >
                      {f.status}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {formatMoneyCents(f.totalPaidCents)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {f.claimsPaidCount ?? "—"}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {f.claimsDeniedCount ?? "—"}
                    </td>
                    <td
                      className="p-3 text-[12px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      <span className="block">
                        {new Date(f.ingestedAt).toLocaleString()}
                      </span>
                      {f.ingestedByEmail && (
                        <span className="block">{f.ingestedByEmail}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
