// /admin/billing/office-ally — Office Ally Operations.
//
// Single page that consolidates every Office Ally workflow an admin
// needs day-to-day, so they don't have to grep multiple screens:
//
//   1. Submissions — newest 837P uploads with status, control
//      numbers, ack timestamps. Actions per row: Download raw 837P,
//      Resubmit (when transport_failed).
//   2. Inbound ack files — 999 / 277CA / 835 / 271 files the poller
//      pulled from OA's outbound directory, with parsed summary and
//      dispatch status.
//   3. Clearinghouse credentials — every configured SFTP target with
//      Test connection + Poll now buttons, plus last-polled
//      timestamp.
//
// The backend routes that power this page all existed before; this
// page is the missing UI that made them usable.

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchClearinghouses,
  fetchInboundFiles,
  fetchOaSubmissions,
  pollNow,
  rawEdiDownloadHref,
  resubmitOaSubmission,
  testClearinghouseConnection,
  type ClearinghouseRow,
  type ConnectionTestResult,
  type InboundFile,
  type InboundFileKind,
  type OaSubmission,
  type OaSubmissionStatus,
} from "@/lib/admin/office-ally-api";

export function AdminBillingOfficeAllyPage() {
  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-office-ally"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Office Ally Operations
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Outbound 837P submissions, inbound acks (999 / 277CA / 835 / 271), and clearinghouse connection — all in one place.
        </p>
      </header>

      <SubmissionsSection />
      <InboundFilesSection />
      <ClearinghousesSection />
    </div>
  );
}

// ── Submissions ────────────────────────────────────────────────────

const SUBMISSION_STATUS_OPTIONS: Array<{
  value: "" | OaSubmissionStatus;
  label: string;
}> = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "uploaded", label: "Uploaded" },
  { value: "accepted_999", label: "Accepted (999)" },
  { value: "rejected_999", label: "Rejected (999)" },
  { value: "accepted_277ca", label: "Accepted (277CA)" },
  { value: "rejected_277ca", label: "Rejected (277CA)" },
  { value: "transport_failed", label: "Transport failed" },
];

function SubmissionsSection() {
  const [statusFilter, setStatusFilter] = useState<"" | OaSubmissionStatus>("");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-oa-submissions", { status: statusFilter }],
    queryFn: () =>
      fetchOaSubmissions(
        statusFilter ? { status: statusFilter } : undefined,
      ),
    staleTime: 15_000,
  });

  return (
    <Card title="Submissions (outbound 837P)">
      <div className="flex flex-wrap gap-3 items-end mb-3">
        <label className="block">
          <span
            className="text-xs font-semibold block mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Status
          </span>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "" | OaSubmissionStatus)
            }
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            data-testid="oa-submissions-status-filter"
          >
            {SUBMISSION_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
        >
          ↻ Refresh
        </button>
        <p
          className="text-xs ml-auto"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {data?.submissions.length ?? 0} shown
        </p>
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      {isPending ? (
        <Spinner label="Loading submissions…" />
      ) : (data?.submissions.length ?? 0) === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No submissions match.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left text-[11px] uppercase tracking-wider"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                <th className="p-2">Submitted</th>
                <th className="p-2">File</th>
                <th className="p-2">Claims</th>
                <th className="p-2">Status</th>
                <th className="p-2">ISA / GS</th>
                <th className="p-2">999 ack</th>
                <th className="p-2">277CA ack</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {(data?.submissions ?? []).map((s) => (
                <SubmissionRow key={s.id} s={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SubmissionRow({ s }: { s: OaSubmission }) {
  const queryClient = useQueryClient();
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const resubmitMutation = useMutation({
    mutationFn: () => resubmitOaSubmission(s.id),
    onSuccess: async (r) => {
      setActionMsg(
        r.ok
          ? `Resubmitted as new batch ${r.submissionId.slice(0, 8)} (${r.claimCount} claims, ${r.transport})`
          : `Resubmit failed: ${r.uploadError ?? "unknown"}`,
      );
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-submissions"],
      });
    },
    onError: (err: unknown) => {
      setActionMsg(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <tr
      className="border-t align-top"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`oa-submission-${s.id}`}
    >
      <td className="p-2 text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        {new Date(s.submittedAt).toLocaleString()}
        <br />
        by {s.submittedByEmail}
        {s.parentSubmissionId && (
          <div className="text-[10px]" style={{ color: "#b45309" }}>
            ↻ resubmit of {s.parentSubmissionId.slice(0, 8)}
          </div>
        )}
      </td>
      <td
        className="p-2 font-mono text-[12px]"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {s.fileName}
        <br />
        <span className="text-[10px]" style={{ color: "hsl(var(--ink-3))" }}>
          {(s.fileSizeBytes / 1024).toFixed(1)} KB
        </span>
      </td>
      <td className="p-2" style={{ color: "hsl(var(--ink-1))" }}>
        {s.claimCount}
      </td>
      <td className="p-2">
        <SubmissionStatusBadge status={s.status} />
        {s.rejectionReason && (
          <p
            className="mt-1 text-[10px] max-w-xs"
            style={{ color: "#be123c" }}
          >
            {s.rejectionReason.slice(0, 200)}
          </p>
        )}
      </td>
      <td
        className="p-2 font-mono text-[10px]"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        ISA {s.isaControlNumber}
        <br />
        GS {s.gsControlNumber}
      </td>
      <td className="p-2 text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        {s.ack999ReceivedAt
          ? new Date(s.ack999ReceivedAt).toLocaleDateString()
          : "—"}
      </td>
      <td className="p-2 text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        {s.ack277caReceivedAt
          ? new Date(s.ack277caReceivedAt).toLocaleDateString()
          : "—"}
      </td>
      <td className="p-2">
        <div className="flex flex-col items-end gap-1">
          <a
            href={rawEdiDownloadHref(s.id)}
            className="text-[12px] font-semibold hover:underline whitespace-nowrap"
            style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
            data-testid={`oa-submission-download-${s.id}`}
          >
            ↓ Raw 837P
          </a>
          {s.status === "transport_failed" && s.attemptedClaimIds.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setActionMsg(null);
                resubmitMutation.mutate();
              }}
              disabled={resubmitMutation.isPending}
              className="text-[12px] font-semibold hover:underline disabled:opacity-60 whitespace-nowrap"
              style={{ color: "#15803d" }}
              data-testid={`oa-submission-resubmit-${s.id}`}
            >
              {resubmitMutation.isPending ? "Resubmitting…" : "↻ Resubmit"}
            </button>
          )}
          {actionMsg && (
            <p
              className="text-[10px] max-w-[160px] text-right"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {actionMsg}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}

function SubmissionStatusBadge({ status }: { status: OaSubmissionStatus }) {
  const map: Record<
    OaSubmissionStatus,
    { bg: string; fg: string; label: string }
  > = {
    queued: { bg: "rgba(100,116,139,0.16)", fg: "#475569", label: "queued" },
    uploaded: { bg: "rgba(2,132,199,0.16)", fg: "#0284c7", label: "uploaded" },
    accepted_999: {
      bg: "rgba(21,128,61,0.14)",
      fg: "#15803d",
      label: "999 OK",
    },
    rejected_999: {
      bg: "rgba(190,18,60,0.14)",
      fg: "#be123c",
      label: "999 REJECT",
    },
    accepted_277ca: {
      bg: "rgba(21,128,61,0.14)",
      fg: "#15803d",
      label: "277CA OK",
    },
    rejected_277ca: {
      bg: "rgba(190,18,60,0.14)",
      fg: "#be123c",
      label: "277CA REJECT",
    },
    transport_failed: {
      bg: "rgba(180,83,9,0.18)",
      fg: "#b45309",
      label: "transport failed",
    },
  };
  const c = map[status];
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {c.label}
    </span>
  );
}

// ── Inbound ack files ──────────────────────────────────────────────

const FILE_KIND_OPTIONS: Array<{ value: "" | InboundFileKind; label: string }> = [
  { value: "", label: "All kinds" },
  { value: "999", label: "999 (sync ack)" },
  { value: "277ca", label: "277CA (claim status)" },
  { value: "835", label: "835 (ERA)" },
  { value: "271", label: "271 (eligibility)" },
  { value: "unknown", label: "Unknown" },
];

function InboundFilesSection() {
  const [kind, setKind] = useState<"" | InboundFileKind>("");
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-oa-inbound-files", { kind }],
    queryFn: () => fetchInboundFiles(kind ? { fileKind: kind } : undefined),
    staleTime: 15_000,
  });

  return (
    <Card title="Inbound ack files (999 / 277CA / 835 / 271)">
      <div className="flex flex-wrap gap-3 items-end mb-3">
        <label className="block">
          <span
            className="text-xs font-semibold block mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            File kind
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "" | InboundFileKind)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            data-testid="oa-inbound-kind-filter"
          >
            {FILE_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
        >
          ↻ Refresh
        </button>
        <p
          className="text-xs ml-auto"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {data?.files.length ?? 0} shown
        </p>
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      {isPending ? (
        <Spinner label="Loading inbound files…" />
      ) : (data?.files.length ?? 0) === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No inbound files. The poller runs every 15 minutes; use Poll now below to fetch on demand.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left text-[11px] uppercase tracking-wider"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                <th className="p-2">Downloaded</th>
                <th className="p-2">File</th>
                <th className="p-2">Kind</th>
                <th className="p-2">Dispatch</th>
                <th className="p-2">Summary</th>
              </tr>
            </thead>
            <tbody>
              {(data?.files ?? []).map((f) => (
                <InboundFileRow key={f.id} f={f} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function InboundFileRow({ f }: { f: InboundFile }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <tr
      className="border-t align-top"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`oa-inbound-file-${f.id}`}
    >
      <td className="p-2 text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        {new Date(f.downloadedAt).toLocaleString()}
      </td>
      <td
        className="p-2 font-mono text-[12px]"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {f.fileName}
        <br />
        <span className="text-[10px]" style={{ color: "hsl(var(--ink-3))" }}>
          {(f.fileSizeBytes / 1024).toFixed(1)} KB
        </span>
      </td>
      <td className="p-2">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
          style={{
            backgroundColor: "rgba(100,116,139,0.16)",
            color: "#475569",
          }}
        >
          {f.fileKind}
        </span>
      </td>
      <td className="p-2">
        <DispatchBadge status={f.dispatchStatus} />
        {f.errorMessage && (
          <p className="mt-1 text-[10px]" style={{ color: "#be123c" }}>
            {f.errorMessage.slice(0, 160)}
          </p>
        )}
      </td>
      <td className="p-2 text-[11px]" style={{ color: "hsl(var(--ink-2))" }}>
        {f.parseSummary ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] font-semibold hover:underline"
              style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
            >
              {expanded ? "Hide details" : "Show details"}
            </button>
            {expanded && (
              <pre className="mt-1 max-w-md whitespace-pre-wrap rounded bg-slate-50 p-2 text-[10px]">
                {JSON.stringify(f.parseSummary, null, 2)}
              </pre>
            )}
          </>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

function DispatchBadge({
  status,
}: {
  status: InboundFile["dispatchStatus"];
}) {
  const map: Record<
    InboundFile["dispatchStatus"],
    { bg: string; fg: string }
  > = {
    pending: { bg: "rgba(100,116,139,0.16)", fg: "#475569" },
    parsed: { bg: "rgba(2,132,199,0.16)", fg: "#0284c7" },
    dispatched: { bg: "rgba(21,128,61,0.14)", fg: "#15803d" },
    dispatch_failed: { bg: "rgba(190,18,60,0.14)", fg: "#be123c" },
    skipped: { bg: "rgba(180,83,9,0.18)", fg: "#b45309" },
  };
  const c = map[status];
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ── Clearinghouses (connection self-test + poll now) ───────────────

function ClearinghousesSection() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-clearinghouses"],
    queryFn: fetchClearinghouses,
    staleTime: 60_000,
  });

  const pollMutation = useMutation({
    mutationFn: pollNow,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-inbound-files"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["admin-clearinghouses"],
      });
    },
  });

  return (
    <Card title="Clearinghouse credentials">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => pollMutation.mutate()}
          disabled={pollMutation.isPending}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          data-testid="oa-poll-now"
        >
          {pollMutation.isPending ? "Polling…" : "↓ Poll Office Ally now"}
        </button>
        <p
          className="text-xs"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Manually fires the inbound poller (cron also runs it every 15 min).
        </p>
        {pollMutation.data && (
          <p
            className="text-xs ml-auto"
            style={{ color: "#15803d" }}
          >
            Last poll: {JSON.stringify(pollMutation.data.stats)}
          </p>
        )}
        {pollMutation.error && (
          <p
            className="text-xs ml-auto"
            style={{ color: "#be123c" }}
          >
            Poll failed: {String(pollMutation.error)}
          </p>
        )}
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      {isPending ? (
        <Spinner label="Loading clearinghouses…" />
      ) : (data?.clearinghouses.length ?? 0) === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No clearinghouse credentials configured. Add one via the
          {" "}<code className="font-mono text-[11px]">POST /admin/clearinghouse-credentials</code>{" "}
          backend route (or set the OFFICE_ALLY_* env vars for stub mode).
        </p>
      ) : (
        <div className="space-y-2">
          {(data?.clearinghouses ?? []).map((c) => (
            <ClearinghouseCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ClearinghouseCard({ c }: { c: ClearinghouseRow }) {
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
    null,
  );

  const testMutation = useMutation({
    mutationFn: () => testClearinghouseConnection(c.id),
    onSuccess: (r) => setTestResult(r),
    onError: (err: unknown) =>
      setTestResult({
        ok: false,
        kind: "test_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  return (
    <div
      className="rounded border p-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`oa-clearinghouse-${c.slug}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p
            className="font-semibold text-sm"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {c.displayName}{" "}
            <span
              className="ml-1 inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase"
              style={{
                backgroundColor:
                  c.usageIndicator === "P"
                    ? "rgba(21,128,61,0.14)"
                    : "rgba(180,83,9,0.18)",
                color: c.usageIndicator === "P" ? "#15803d" : "#b45309",
              }}
            >
              {c.usageIndicator === "P" ? "production" : "test"}
            </span>
            {!c.isActive && (
              <span
                className="ml-1 inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase"
                style={{
                  backgroundColor: "rgba(100,116,139,0.16)",
                  color: "#475569",
                }}
              >
                inactive
              </span>
            )}
          </p>
          <p
            className="text-[11px] font-mono mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {c.sftpUsername}@{c.sftpHost}:{c.sftpPort}
            {" · "}inbox {c.remoteInboxDir} · outbound {c.remoteOutboundDir}
          </p>
          <p
            className="text-[11px] mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            ETIN {c.etin} · last polled{" "}
            {c.lastPolledAt
              ? new Date(c.lastPolledAt).toLocaleString()
              : "never"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => {
              setTestResult(null);
              testMutation.mutate();
            }}
            disabled={testMutation.isPending}
            className="rounded border border-slate-300 px-3 py-1 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
            data-testid={`oa-clearinghouse-test-${c.slug}`}
          >
            {testMutation.isPending ? "Testing…" : "Test connection"}
          </button>
          {testResult && <ConnectionResultBadge result={testResult} />}
        </div>
      </div>
    </div>
  );
}

function ConnectionResultBadge({
  result,
}: {
  result: ConnectionTestResult;
}) {
  if (result.ok) {
    return (
      <p className="text-[11px]" style={{ color: "#15803d" }}>
        ✓ Connected — {result.fileCount} files in outbound
      </p>
    );
  }
  return (
    <p
      className="text-[11px] max-w-[220px] text-right"
      style={{ color: "#be123c" }}
    >
      ✗ {result.kind}: {result.message}
    </p>
  );
}
