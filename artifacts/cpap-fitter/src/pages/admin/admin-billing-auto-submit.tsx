// /admin/billing/auto-submit — automatic claim submission worklist.
//
// The staged-approval half of auto-submission: the claims that are
// ready to transmit RIGHT NOW (preflight-clean AND active, recent
// eligibility on file), grouped per payer. The operator reviews and
// one-click submits a payer batch, the selected claims, or everything.
//
// The unattended cron (billing.auto-submit-batch) runs the exact same
// engine on a schedule when CLAIMS_AUTOSUBMIT_CRON is set AND the
// billing.auto_submit_claims feature flag is ON; this page surfaces that
// automation status so an operator can see at a glance whether claims
// are flowing on their own.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Layers,
  Send,
  Zap,
} from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { formatMoneyCents } from "@/lib/admin/billing-api";
import {
  exclusionLabel,
  fetchAutoSubmitReady,
  fetchAutoSubmitStatus,
  runAutoSubmit,
  type AutoSubmitRunResult,
  type AutoSubmitStatus,
  type ExclusionReason,
  type ReadyGroup,
} from "@/lib/admin/billing-auto-submit-api";

const READY_QUERY_KEY = ["admin-billing-auto-submit-ready"] as const;
const STATUS_QUERY_KEY = ["admin-billing-auto-submit-status"] as const;
// How many ready claims the worklist loads and "Submit all ready" sends.
// The same cap is passed through to the run so "Submit all ready (N)"
// transmits all N shown — not the engine's smaller per-cron-tick default.
const READY_CAP = 200;

export function AdminBillingAutoSubmitPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastResult, setLastResult] = useState<AutoSubmitRunResult | null>(
    null,
  );

  const readyQuery = useQuery({
    queryKey: READY_QUERY_KEY,
    queryFn: () => fetchAutoSubmitReady(READY_CAP),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const statusQuery = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: fetchAutoSubmitStatus,
    staleTime: 30_000,
  });

  const groups = useMemo(
    () => readyQuery.data?.groups ?? [],
    [readyQuery.data],
  );
  const allReadyIds = useMemo(
    () => groups.flatMap((g) => g.claims.map((c) => c.claimId)),
    [groups],
  );

  const runMutation = useMutation({
    // claimIds present → operator-approved subset; absent → "submit all
    // ready", which passes maxClaims so the server sends every claim the
    // worklist showed (up to READY_CAP) rather than its smaller default.
    mutationFn: (claimIds?: string[]) =>
      runAutoSubmit(
        claimIds && claimIds.length > 0
          ? { claimIds }
          : { maxClaims: READY_CAP },
      ),
    onSuccess: (result) => {
      setLastResult(result);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: READY_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  function toggleOne(claimId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(claimId)) next.delete(claimId);
      else next.add(claimId);
      return next;
    });
  }
  function toggleGroup(group: ReadyGroup) {
    const ids = group.claims.map((c) => c.claimId);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function submit(claimIds?: string[], label?: string) {
    const count = claimIds?.length ?? allReadyIds.length;
    if (count === 0) return;
    const ok = window.confirm(
      `Submit ${count} claim${count === 1 ? "" : "s"}${
        label ? ` (${label})` : ""
      } to Office Ally now? This transmits real 837P claim files.`,
    );
    if (!ok) return;
    runMutation.mutate(claimIds);
  }

  const data = readyQuery.data;
  const excludedByReason = useMemo(() => {
    const m = new Map<ExclusionReason, number>();
    for (const e of data?.excluded ?? []) {
      m.set(e.reason, (m.get(e.reason) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-auto-submit"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Auto-submit claims
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Draft claims that are ready to transmit right now — preflight-clean
          and with active, recent eligibility on file — grouped by payer.
          Approve a payer batch, the selected claims, or everything.
        </p>
      </header>

      {readyQuery.isError && (
        <ErrorPanel
          error={readyQuery.error}
          onRetry={() => void readyQuery.refetch()}
        />
      )}

      <AutomationBanner status={statusQuery.data} />

      {lastResult && (
        <RunResultPanel
          result={lastResult}
          onDismiss={() => setLastResult(null)}
        />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryPill
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Ready to submit"
          value={data?.readyClaimCount ?? 0}
          isLoading={readyQuery.isPending}
          tone="success"
        />
        <SummaryPill
          icon={<Layers className="h-4 w-4" />}
          label="Payers"
          value={data?.readyPayerCount ?? 0}
          isLoading={readyQuery.isPending}
        />
        <SummaryPill
          icon={<Send className="h-4 w-4" />}
          label="Ready total"
          value={formatMoneyCents(data?.readyTotalBilledCents ?? 0)}
          isLoading={readyQuery.isPending}
        />
        <SummaryPill
          icon={<AlertCircle className="h-4 w-4" />}
          label="Held back"
          value={data?.excluded.length ?? 0}
          isLoading={readyQuery.isPending}
          tone="warning"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          intent="primary"
          onClick={() => submit(undefined, "all ready")}
          disabled={runMutation.isPending || allReadyIds.length === 0}
          data-testid="auto-submit-all"
        >
          <Send className="h-4 w-4" />
          {runMutation.isPending
            ? "Submitting…"
            : `Submit all ready (${allReadyIds.length})`}
        </Button>
        <Button
          intent="secondary"
          onClick={() => submit([...selected], "selected")}
          disabled={runMutation.isPending || selected.size === 0}
          data-testid="auto-submit-selected"
        >
          {`Submit selected (${selected.size})`}
        </Button>
        <Button
          intent="ghost"
          onClick={() => void readyQuery.refetch()}
          disabled={readyQuery.isFetching}
        >
          {readyQuery.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {runMutation.isError && <ErrorPanel error={runMutation.error} />}

      {readyQuery.isPending ? (
        <Spinner label="Finding ready claims…" />
      ) : groups.length === 0 ? (
        <Card>
          <p className="text-sm py-2" style={{ color: "hsl(var(--ink-3))" }}>
            No claims are ready to submit right now. Claims appear here once
            they pass preflight with no blocking errors and their coverage shows
            active, recent eligibility.
          </p>
        </Card>
      ) : (
        groups.map((group) => (
          <PayerGroupCard
            key={group.payerProfileId}
            group={group}
            selected={selected}
            onToggleOne={toggleOne}
            onToggleGroup={() => toggleGroup(group)}
            onSubmitGroup={() =>
              submit(
                group.claims.map((c) => c.claimId),
                group.payerName,
              )
            }
            submitting={runMutation.isPending}
          />
        ))
      )}

      {excludedByReason.length > 0 && (
        <Card
          title="Held back"
          subtitle="Drafts that aren't ready yet — fix the reason to release them"
        >
          <ul className="space-y-1 text-sm">
            {excludedByReason.map(([reason, count]) => (
              <li
                key={reason}
                className="flex items-center justify-between"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                <span>{exclusionLabel(reason)}</span>
                <span className="tabular-nums font-semibold">{count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function AutomationBanner({
  status,
}: {
  status: AutoSubmitStatus | undefined;
}) {
  if (!status) return null;
  const { autoSubmit } = status;
  const active = autoSubmit.active;
  return (
    <div
      className="surface-card p-4 flex items-start gap-3"
      data-testid="auto-submit-automation-banner"
    >
      <Zap
        className="h-5 w-5 mt-0.5"
        style={{ color: active ? "#15803d" : "hsl(var(--ink-3))" }}
      />
      <div className="text-sm">
        <p className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
          Unattended auto-submit:{" "}
          <span style={{ color: active ? "#15803d" : "#b45309" }}>
            {active ? "ON" : "OFF"}
          </span>
        </p>
        <p style={{ color: "hsl(var(--ink-2))" }}>
          {active ? (
            <>
              The cron is sending up to {autoSubmit.maxClaimsPerRun} ready
              claims per run ({autoSubmit.cronExpression}). The staged approval
              below still works any time.
            </>
          ) : (
            <>
              Claims are only sent when an operator approves them below. To run
              it on a schedule, set <code>CLAIMS_AUTOSUBMIT_CRON</code>
              {autoSubmit.cronConfigured ? "" : " (not set)"} and turn on the{" "}
              <Link
                href="/admin/control-center"
                className="underline"
                style={{ color: "hsl(var(--penn-navy))" }}
              >
                billing.auto_submit_claims
              </Link>{" "}
              flag{autoSubmit.flagEnabled ? " (on)" : " (off)"}.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function RunResultPanel({
  result,
  onDismiss,
}: {
  result: AutoSubmitRunResult;
  onDismiss: () => void;
}) {
  const hadFailures = result.failures.length > 0;
  return (
    <div
      className="surface-card p-4"
      style={{
        borderLeft: `3px solid ${hadFailures ? "#b45309" : "#15803d"}`,
      }}
      data-testid="auto-submit-result"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm">
          <p className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            Submitted {result.claimsSubmitted} claim
            {result.claimsSubmitted === 1 ? "" : "s"} in{" "}
            {result.batchesAttempted} batch
            {result.batchesAttempted === 1 ? "" : "es"}.
          </p>
          {hadFailures && (
            <p className="mt-1" style={{ color: "#b45309" }}>
              {result.failures.length} batch
              {result.failures.length === 1 ? "" : "es"} failed:{" "}
              {result.failures.map((f) => f.kind).join(", ")}
            </p>
          )}
          {result.skippedNotReady.length > 0 && (
            <p className="mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              {result.skippedNotReady.length} skipped (no longer ready).
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs underline"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function PayerGroupCard({
  group,
  selected,
  onToggleOne,
  onToggleGroup,
  onSubmitGroup,
  submitting,
}: {
  group: ReadyGroup;
  selected: Set<string>;
  onToggleOne: (claimId: string) => void;
  onToggleGroup: () => void;
  onSubmitGroup: () => void;
  submitting: boolean;
}) {
  const allSelected = group.claims.every((c) => selected.has(c.claimId));
  return (
    <Card
      title={group.payerName}
      subtitle={`${group.claimCount} claim${
        group.claimCount === 1 ? "" : "s"
      } · ${formatMoneyCents(group.totalBilledCents)}`}
    >
      <div className="flex items-center justify-between mb-2">
        <label
          className="inline-flex items-center gap-2 text-xs font-semibold"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onToggleGroup}
            data-testid={`auto-submit-group-select-${group.payerProfileId}`}
          />
          Select all
        </label>
        <Button
          intent="secondary"
          size="sm"
          onClick={onSubmitGroup}
          disabled={submitting}
          data-testid={`auto-submit-group-${group.payerProfileId}`}
        >
          <Send className="h-3.5 w-3.5" />
          Submit payer
        </Button>
      </div>
      <div className="overflow-x-auto -mx-5">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left text-[11px] uppercase tracking-wider"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              <th className="p-3 w-8"></th>
              <th className="p-3">Patient</th>
              <th className="p-3">Date of service</th>
              <th className="p-3">Eligibility</th>
              <th className="p-3 text-right">Billed</th>
              <th className="p-3 text-right">Patient</th>
            </tr>
          </thead>
          <tbody>
            {group.claims.map((c) => (
              <tr
                key={c.claimId}
                className="border-t"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={selected.has(c.claimId)}
                    onChange={() => onToggleOne(c.claimId)}
                    data-testid={`auto-submit-claim-${c.claimId}`}
                  />
                </td>
                <td
                  className="p-3 font-medium"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {c.patientName}
                </td>
                <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
                  {c.dateOfService ?? "—"}
                </td>
                <td className="p-3 text-[12px]">
                  <span
                    className="inline-flex items-center gap-1"
                    style={{ color: "#15803d" }}
                  >
                    <Clock className="h-3 w-3" />
                    {c.eligibilityVerifiedAt
                      ? new Date(c.eligibilityVerifiedAt).toLocaleDateString()
                      : "verified"}
                  </span>
                </td>
                <td
                  className="p-3 text-right tabular-nums"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {formatMoneyCents(c.totalBilledCents)}
                </td>
                <td className="p-3 text-right">
                  <Link
                    href={`/admin/patients/${c.patientId}`}
                    className="text-xs underline"
                    style={{ color: "hsl(var(--penn-navy))" }}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SummaryPill({
  icon,
  label,
  value,
  isLoading,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  isLoading: boolean;
  tone?: "default" | "success" | "danger" | "warning";
}) {
  const colors: Record<typeof tone, string> = {
    default: "hsl(var(--ink-1))",
    success: "#15803d",
    danger: "#b91c1c",
    warning: "#b45309",
  };
  return (
    <div className="surface-card p-4">
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1 inline-flex items-center gap-1.5"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        <span style={{ color: colors[tone] }}>{icon}</span>
        {label}
      </p>
      <p
        className="text-2xl font-semibold tabular-nums leading-none"
        style={{ color: colors[tone] }}
      >
        {isLoading ? (
          <span className="skeleton inline-block h-6 w-10 align-middle" />
        ) : (
          value
        )}
      </p>
    </div>
  );
}
