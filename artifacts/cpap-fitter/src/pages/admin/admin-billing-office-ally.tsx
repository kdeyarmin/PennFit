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
import { Link } from "wouter";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  bulkResubmitOaSubmissions,
  fetchClearinghouses,
  fetchEnrollmentWatchlist,
  fetchInboundFiles,
  fetchOaHealth,
  fetchOaOperationsSummary,
  fetchOaPayerStats,
  fetchOaSubmissions,
  pollNow,
  rawEdiDownloadHref,
  resubmitOaSubmission,
  submissionsCsvHref,
  testClearinghouseConnection,
  uploadOaAck,
  type BulkResubmitResponse,
  type ClearinghouseRow,
  type ConnectionTestResult,
  type EnrollmentWatchlistEntry,
  type InboundFile,
  type InboundFileKind,
  type OaHealth,
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

      <HealthBanner />
      <KpiRow />
      <EnrollmentWatchlistBanner />
      <PayerStatsCard />
      <SubmissionsSection />
      <InboundFilesSection />
      <ClearinghousesSection />
    </div>
  );
}

// ── Top payers by submission volume (last 30 days) ─────────────────

function PayerStatsCard() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["admin-oa-payer-stats"],
    queryFn: fetchOaPayerStats,
    staleTime: 60_000,
  });
  if (isError) return null;
  if (!isPending && (data?.payers.length ?? 0) === 0) return null;
  return (
    <Card title="By payer (last 30 days)">
      {isPending ? (
        <Spinner label="Loading payer stats…" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left text-[11px] uppercase tracking-wider"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                <th className="p-2">Payer</th>
                <th className="p-2 text-right">Batches</th>
                <th className="p-2 text-right">Claims</th>
                <th className="p-2 text-right">Accepted</th>
                <th className="p-2 text-right">Rejected</th>
                <th className="p-2 text-right">Failed</th>
                <th className="p-2 text-right">Pending</th>
                <th className="p-2 text-right">Acceptance</th>
              </tr>
            </thead>
            <tbody>
              {(data?.payers ?? []).map((p) => (
                <tr
                  key={p.payerProfileId}
                  className="border-t"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                  data-testid={`oa-payer-stats-${p.slug ?? p.payerProfileId}`}
                >
                  <td className="p-2">
                    <p
                      className="font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {p.displayName}
                    </p>
                    <p
                      className="text-[10px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {p.lineOfBusiness ?? "—"}
                    </p>
                  </td>
                  <td
                    className="p-2 text-right tabular-nums"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {p.submissionCount}
                  </td>
                  <td
                    className="p-2 text-right tabular-nums"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    {p.claimCount}
                  </td>
                  <td
                    className="p-2 text-right tabular-nums"
                    style={{ color: "#15803d" }}
                  >
                    {p.acceptedCount}
                  </td>
                  <td
                    className="p-2 text-right tabular-nums"
                    style={{
                      color: p.rejectedCount > 0 ? "#be123c" : "hsl(var(--ink-3))",
                    }}
                  >
                    {p.rejectedCount}
                  </td>
                  <td
                    className="p-2 text-right tabular-nums"
                    style={{
                      color: p.transportFailedCount > 0 ? "#b45309" : "hsl(var(--ink-3))",
                    }}
                  >
                    {p.transportFailedCount}
                  </td>
                  <td
                    className="p-2 text-right tabular-nums"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {p.pendingCount}
                  </td>
                  <td className="p-2 text-right tabular-nums font-semibold">
                    <AcceptanceCell pct={p.acceptanceRatePct} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AcceptanceCell({ pct }: { pct: number | null }) {
  if (pct == null) {
    return (
      <span style={{ color: "hsl(var(--ink-3))" }}>—</span>
    );
  }
  const color =
    pct >= 95 ? "#15803d" : pct >= 85 ? "#b45309" : "#be123c";
  return <span style={{ color }}>{pct}%</span>;
}

// ── Health banner (transport / poll status) ─────────────────────────

function HealthBanner() {
  const { data, isPending } = useQuery({
    queryKey: ["admin-oa-health"],
    queryFn: fetchOaHealth,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  if (isPending || !data) return null;

  // Hide the banner when everything is healthy AND no recent
  // transport failures — the dashboard already shows green KPIs.
  if (
    data.hasActiveClearinghouse &&
    data.pollStatus === "fresh" &&
    data.recentTransportFailures === 0
  ) {
    return null;
  }

  const { tone, headline, body } = healthMessage(data);
  return (
    <div
      className="rounded border-l-4 p-3"
      style={{ backgroundColor: tone.bg, borderColor: tone.fg }}
      data-testid="oa-health-banner"
      data-poll-status={data.pollStatus}
    >
      <p className="text-sm font-semibold" style={{ color: tone.fg }}>
        {headline}
      </p>
      <p
        className="text-[12px] mt-0.5"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {body}
      </p>
    </div>
  );
}

function healthMessage(h: OaHealth): {
  tone: { bg: string; fg: string };
  headline: string;
  body: string;
} {
  const red = { bg: "rgba(190,18,60,0.08)", fg: "#be123c" };
  const amber = { bg: "rgba(180,83,9,0.08)", fg: "#b45309" };
  const slate = { bg: "rgba(100,116,139,0.1)", fg: "#475569" };

  if (!h.hasActiveClearinghouse) {
    return {
      tone: slate,
      headline: "No active clearinghouse configured",
      body: "Set up OFFICE_ALLY_* env or add a clearinghouse_credentials row to submit electronically.",
    };
  }
  if (h.pollStatus === "outage") {
    return {
      tone: red,
      headline: `⛔ Office Ally poller has not run in ${h.minutesSinceLastPoll} min`,
      body: `Inbound 999 / 277CA / 835 files may be stuck on OA's side. Hit "Poll Office Ally now" below to retry — if that errors, check SFTP creds.`,
    };
  }
  if (h.pollStatus === "never") {
    return {
      tone: amber,
      headline: "Office Ally poller has never run on this clearinghouse",
      body: `Hit "Poll Office Ally now" below to verify the SFTP connection.`,
    };
  }
  if (h.pollStatus === "stale") {
    return {
      tone: amber,
      headline: `⚠ Last poll was ${h.minutesSinceLastPoll} min ago`,
      body: `The cron runs every 15 min; > 60 min is unusual. Check the worker logs if this persists.`,
    };
  }
  // pollStatus === "fresh" + recentTransportFailures > 0
  return {
    tone: red,
    headline: `⛔ ${h.recentTransportFailures} 837P upload${h.recentTransportFailures === 1 ? "" : "s"} failed at transport in the last hour`,
    body: "Open the failed submission(s) below, click Resubmit. If the failure repeats, run Test connection on the clearinghouse.",
  };
}

// ── KPI row (last 30 days) ──────────────────────────────────────────

function KpiRow() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["admin-oa-operations-summary"],
    queryFn: fetchOaOperationsSummary,
    staleTime: 60_000,
  });
  if (isError) return null;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      data-testid="oa-kpi-row"
    >
      <KpiTile label="Submissions (30d)" value={data?.counts.totalSubmissions} loading={isPending} />
      <KpiTile label="Claims (30d)" value={data?.counts.totalClaims} loading={isPending} />
      <KpiTile
        label="Acceptance"
        value={
          data?.rates.acceptanceRatePct == null
            ? "—"
            : `${data.rates.acceptanceRatePct}%`
        }
        loading={isPending}
        tone={
          data?.rates.acceptanceRatePct != null && data.rates.acceptanceRatePct < 90
            ? "alert"
            : "ok"
        }
      />
      <KpiTile
        label="Pending acks"
        value={data?.counts.pendingAck}
        hint=">1h uploaded, no 999"
        loading={isPending}
        tone={
          data?.counts.pendingAck != null && data.counts.pendingAck > 0
            ? "warn"
            : "neutral"
        }
      />
      <KpiTile
        label="Transport failed"
        value={data?.counts.transportFailed}
        loading={isPending}
        tone={
          data?.counts.transportFailed != null && data.counts.transportFailed > 0
            ? "alert"
            : "neutral"
        }
      />
      <KpiTile
        label="Avg min to 999"
        value={
          data?.rates.avgMinutesToAck999 == null
            ? "—"
            : `${data.rates.avgMinutesToAck999}m`
        }
        loading={isPending}
      />
    </div>
  );
}

function KpiTile({
  label,
  value,
  hint,
  loading,
  tone = "neutral",
}: {
  label: string;
  value: number | string | undefined;
  hint?: string;
  loading?: boolean;
  tone?: "neutral" | "ok" | "warn" | "alert";
}) {
  const toneColor =
    tone === "ok"
      ? "#15803d"
      : tone === "warn"
        ? "#b45309"
        : tone === "alert"
          ? "#be123c"
          : "hsl(var(--ink-1))";
  return (
    <div
      className="rounded border p-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <p
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </p>
      <p
        className="mt-1 text-xl font-semibold tabular-nums"
        style={{ color: toneColor }}
      >
        {loading ? "…" : (value ?? "—")}
      </p>
      {hint && (
        <p
          className="mt-0.5 text-[10px]"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

// ── Enrollment watchlist (pending / not_enrolled payers) ───────────

function EnrollmentWatchlistBanner() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["admin-oa-enrollment-watchlist"],
    queryFn: fetchEnrollmentWatchlist,
    staleTime: 60_000,
  });
  if (isPending || isError) return null;
  const payers = data?.payers ?? [];
  if (payers.length === 0) return null;
  return (
    <div
      className="rounded border-l-4 p-3"
      style={{
        backgroundColor: "rgba(180,83,9,0.08)",
        borderColor: "#b45309",
      }}
      data-testid="oa-enrollment-watchlist-banner"
    >
      <p className="text-sm font-semibold" style={{ color: "#b45309" }}>
        ⚠ {payers.length}{" "}
        {payers.length === 1 ? "payer is" : "payers are"} awaiting Office Ally enrollment
      </p>
      <p
        className="text-[12px] mt-0.5 mb-2"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        Claims to these payers will be blocked at preflight until the enrollment status is updated to{" "}
        <code className="font-mono text-[11px]">enrolled</code>{" "}
        in the payer catalog.
      </p>
      <ul className="text-[12px] space-y-0.5">
        {payers.slice(0, 8).map((p) => (
          <EnrollmentEntry key={p.id} p={p} />
        ))}
        {payers.length > 8 && (
          <li className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
            …and {payers.length - 8} more.
          </li>
        )}
      </ul>
    </div>
  );
}

function EnrollmentEntry({ p }: { p: EnrollmentWatchlistEntry }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span
        className="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase"
        style={{
          backgroundColor:
            p.ediEnrollmentStatus === "pending"
              ? "rgba(180,83,9,0.18)"
              : "rgba(190,18,60,0.16)",
          color: p.ediEnrollmentStatus === "pending" ? "#b45309" : "#be123c",
        }}
      >
        {p.ediEnrollmentStatus.replace("_", " ")}
      </span>
      <span style={{ color: "hsl(var(--ink-1))" }}>{p.displayName}</span>
      <span className="text-[10px]" style={{ color: "hsl(var(--ink-3))" }}>
        {p.lineOfBusiness}
        {p.officeAllyPayerId && ` · OA ${p.officeAllyPayerId}`}
      </span>
      <Link
        href="/admin/billing/config/payers"
        className="text-[11px] font-semibold hover:underline ml-auto"
        style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
      >
        Open in catalog →
      </Link>
    </li>
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
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"" | OaSubmissionStatus>("");
  const [search, setSearch] = useState("");
  // Set of submission ids selected for bulk action. Only `transport_failed`
  // rows can be selected — we surface the checkbox conditionally so a
  // CSR can't waste clicks on rows that can't be resubmitted.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkResubmitResponse | null>(
    null,
  );

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-oa-submissions", { status: statusFilter, q: search }],
    queryFn: () =>
      fetchOaSubmissions({
        status: statusFilter || undefined,
        q: search || undefined,
      }),
    staleTime: 15_000,
  });

  // Drop selections that no longer match the current view (filter
  // changed, refresh evicted, etc) so the bulk bar stays accurate.
  const visibleIds = new Set(
    (data?.submissions ?? []).map((s) => s.id),
  );
  const activeSelections = new Set(
    [...selectedIds].filter((id) => visibleIds.has(id)),
  );

  const bulkResubmitMut = useMutation({
    mutationFn: (ids: string[]) => bulkResubmitOaSubmissions(ids),
    onSuccess: async (r) => {
      setBulkResult(r);
      setSelectedIds(new Set());
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-submissions"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-operations-summary"],
      });
    },
  });

  function toggleSelect(id: string, on: boolean) {
    setBulkResult(null);
    const next = new Set(selectedIds);
    if (on) next.add(id);
    else next.delete(id);
    setSelectedIds(next);
  }
  function selectAllFailed() {
    setBulkResult(null);
    const failedIds = (data?.submissions ?? [])
      .filter(
        (s) =>
          s.status === "transport_failed" && s.attemptedClaimIds.length > 0,
      )
      .map((s) => s.id);
    setSelectedIds(new Set(failedIds));
  }
  function clearSelection() {
    setBulkResult(null);
    setSelectedIds(new Set());
  }

  return (
    <Card title="Submissions (outbound 837P)">
      <div className="flex flex-wrap gap-3 items-end mb-3">
        <label className="block">
          <span
            className="text-xs font-semibold block mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Search
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ISA control # or file name"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm font-mono w-64"
            data-testid="oa-submissions-search"
          />
        </label>
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
        <a
          href={submissionsCsvHref({
            status: statusFilter || undefined,
            q: search || undefined,
          })}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
          style={{ color: "hsl(var(--ink-1))" }}
          data-testid="oa-submissions-export-csv"
        >
          ↓ CSV (90d)
        </a>
        <p
          className="text-xs ml-auto"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {data?.submissions.length ?? 0} shown
        </p>
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <BulkActionBar
        selectedCount={activeSelections.size}
        onSelectAllFailed={selectAllFailed}
        onClear={clearSelection}
        onBulkResubmit={() =>
          bulkResubmitMut.mutate(Array.from(activeSelections))
        }
        running={bulkResubmitMut.isPending}
        bulkResult={bulkResult}
      />

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
                <th className="p-2 w-6" />
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
                <SubmissionRow
                  key={s.id}
                  s={s}
                  selected={activeSelections.has(s.id)}
                  onToggleSelect={(on) => toggleSelect(s.id, on)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function BulkActionBar({
  selectedCount,
  onSelectAllFailed,
  onClear,
  onBulkResubmit,
  running,
  bulkResult,
}: {
  selectedCount: number;
  onSelectAllFailed: () => void;
  onClear: () => void;
  onBulkResubmit: () => void;
  running: boolean;
  bulkResult: BulkResubmitResponse | null;
}) {
  if (selectedCount === 0 && !bulkResult) {
    return (
      <div className="mb-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onSelectAllFailed}
          className="text-[12px] font-semibold hover:underline"
          style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
          data-testid="oa-submissions-select-all-failed"
        >
          Select all transport-failed
        </button>
      </div>
    );
  }

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-3 rounded border p-2"
      style={{
        backgroundColor: "rgba(2,132,199,0.05)",
        borderColor: "#0284c7",
      }}
      data-testid="oa-submissions-bulk-bar"
    >
      <p className="text-sm font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
        {selectedCount} selected
      </p>
      <button
        type="button"
        onClick={onBulkResubmit}
        disabled={selectedCount === 0 || running}
        className="rounded bg-emerald-700 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
        data-testid="oa-submissions-bulk-resubmit"
      >
        {running ? "Resubmitting…" : `↻ Resubmit ${selectedCount}`}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="text-[12px] font-semibold hover:underline"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        Clear selection
      </button>
      {bulkResult && (
        <p
          className="ml-auto text-[12px]"
          style={{
            color: bulkResult.failedCount === 0 ? "#15803d" : "#b45309",
          }}
        >
          ✓ {bulkResult.okCount} resubmitted
          {bulkResult.failedCount > 0 && (
            <span style={{ color: "#be123c" }}>
              {" · "}
              {bulkResult.failedCount} failed
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function SubmissionRow({
  s,
  selected,
  onToggleSelect,
}: {
  s: OaSubmission;
  selected: boolean;
  onToggleSelect: (on: boolean) => void;
}) {
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

  // Only rows that can actually be resubmitted are selectable —
  // anything else dims the checkbox so a CSR doesn't pick rows the
  // bulk endpoint will skip.
  const selectable =
    s.status === "transport_failed" && s.attemptedClaimIds.length > 0;

  return (
    <tr
      className="border-t align-top"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`oa-submission-${s.id}`}
    >
      <td className="p-2">
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggleSelect(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
            aria-label={`Select submission ${s.fileName} for bulk resubmit`}
            data-testid={`oa-submission-checkbox-${s.id}`}
          />
        ) : (
          <span
            className="inline-block h-4 w-4"
            aria-hidden
            title="Only transport_failed submissions can be bulk-resubmitted"
          />
        )}
      </td>
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
        <Link
          href={`/admin/billing/office-ally/${s.id}`}
          className="hover:underline"
          style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
          data-testid={`oa-submission-link-${s.id}`}
        >
          {s.fileName}
        </Link>
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
  const [uploadOpen, setUploadOpen] = useState(false);
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
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
          data-testid="oa-inbound-upload-button"
        >
          ↑ Upload ack file
        </button>
        <p
          className="text-xs ml-auto"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {data?.files.length ?? 0} shown
        </p>
      </div>
      {uploadOpen && (
        <UploadAckModal
          onClose={() => setUploadOpen(false)}
          onUploaded={() => void refetch()}
        />
      )}

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

// ── Manual ack upload modal ─────────────────────────────────────────
//
// Two ways in: paste the EDI text into a textarea, or pick a .txt /
// .835 file and we read it with FileReader. The backend classifies
// + dispatches via the same code the cron poller uses, so the
// resulting state changes (submission status, per-claim events,
// ERA reconciliation) are identical regardless of the source path.

function UploadAckModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<
    | { ok: true; inboundFileId: string; fileKind: string; fileSizeBytes: number }
    | { error: string }
    | null
  >(null);

  const uploadMut = useMutation({
    mutationFn: () =>
      uploadOaAck({
        content,
        fileName: fileName.trim() || undefined,
      }),
    onSuccess: async (r) => {
      setResult(r);
      onUploaded();
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-submissions"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-operations-summary"],
      });
    },
    onError: (err: unknown) => {
      setResult({
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  function handleFile(file: File | null) {
    if (!file) return;
    // Reject before reading the bytes. The backend zod cap is 5MB
    // and the per-route body-parser is sized to match, but a
    // multi-MB pasted log would still tie up the tab on `file.text()`
    // and then 413 server-side with an opaque error. Match the
    // sibling ERA upload modal's 4MB ceiling so the operator gets a
    // crisp client-side message.
    const MAX_FILE_BYTES = 4 * 1024 * 1024;
    if (file.size > MAX_FILE_BYTES) {
      setResult({
        error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is 4 MB.`,
      });
      return;
    }
    setFileName(file.name);
    file.text().then(
      (text) => setContent(text),
      (err) =>
        setResult({
          error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
        }),
    );
  }

  const succeeded = result && "ok" in result;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      data-testid="oa-upload-ack-modal"
    >
      <div
        className="w-full max-w-2xl rounded bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2
              className="text-lg font-semibold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Upload Office Ally ack file
            </h2>
            <p
              className="text-[12px]"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Drop a 999 / 277CA / 835 / 271 file we received out-of-band (email, support ticket, manual SFTP grab). The backend classifies + dispatches it the same way the cron poller does.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {succeeded ? (
          <div
            className="space-y-2 rounded border p-3"
            style={{
              backgroundColor: "rgba(21,128,61,0.06)",
              borderColor: "#15803d",
            }}
          >
            <p className="text-sm font-semibold" style={{ color: "#15803d" }}>
              ✓ Uploaded + dispatched ({result.fileKind.toUpperCase()})
            </p>
            <p className="text-[12px]" style={{ color: "hsl(var(--ink-2))" }}>
              {result.fileSizeBytes} bytes · inbound file id{" "}
              <code className="font-mono text-[11px]">{result.inboundFileId}</code>
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-slate-900 px-3 py-1 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Done
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setResult(null);
              uploadMut.mutate();
            }}
            className="space-y-3"
          >
            <label className="block">
              <span
                className="text-[11px] font-semibold uppercase tracking-wider mb-1 block"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Pick a file
              </span>
              <input
                type="file"
                accept=".txt,.835,.999,.277,.271,text/plain"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm"
                data-testid="oa-upload-ack-file-input"
              />
            </label>
            <label className="block">
              <span
                className="text-[11px] font-semibold uppercase tracking-wider mb-1 block"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                File name (optional)
              </span>
              <input
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder="e.g. 277CA-2026-05-22-batch3.txt"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
              />
            </label>
            <label className="block">
              <span
                className="text-[11px] font-semibold uppercase tracking-wider mb-1 block"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                …or paste EDI content
              </span>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                placeholder="ISA*00*..."
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-[11px] font-mono"
                data-testid="oa-upload-ack-textarea"
              />
              <span
                className="mt-1 block text-[10px]"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Must start with ISA and contain ST*999, ST*277, ST*835, or ST*271 in the first 4 KB.
              </span>
            </label>

            {result && "error" in result && (
              <p
                className="rounded border p-2 text-[12px]"
                style={{
                  backgroundColor: "rgba(190,18,60,0.06)",
                  borderColor: "#be123c",
                  color: "#9f1239",
                }}
              >
                ✗ {result.error}
              </p>
            )}

            <footer className="flex justify-end gap-2 border-t pt-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={uploadMut.isPending || content.length < 20}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                data-testid="oa-upload-ack-submit"
              >
                {uploadMut.isPending ? "Uploading…" : "Upload + dispatch"}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
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
