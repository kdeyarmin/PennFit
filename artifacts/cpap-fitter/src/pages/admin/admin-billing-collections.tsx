// /admin/billing/collections — patient AR collections worklist (0461).
//
// Active + paused dunning runs, highest balance first, with the ladder step
// each is on. Pause (dispute hold), resolve (written off / paid by hand), or
// cancel a run. Runs advance and de-escalate automatically — a balance paid or
// a payment plan started stops the ladder on the next tick. reports.read to
// view; patients.update to manage.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { CircleDollarSign } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  type CollectionsRun,
  getCollectionsWorklist,
  transitionRun,
} from "@/lib/admin/collections-api";

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

const STEP_LABEL: Record<string, string> = {
  statement: "Statement",
  reminder: "Reminder",
  second_notice: "2nd notice",
  final_notice: "Final notice",
  agency: "Agency",
};

export function AdminBillingCollectionsPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["admin", "collections-worklist"] as const,
    queryFn: getCollectionsWorklist,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resolve" | "cancel";
    }) => transitionRun(id, action),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: ["admin", "collections-worklist"],
      }),
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-collections-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CircleDollarSign className="h-6 w-6" />
          Collections
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Patient balances on the dunning ladder. Runs escalate on a cadence and
          stop automatically when a balance is paid or the patient goes on a
          plan — pause, resolve, or cancel a run here when you need to.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Loading collections…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No active collections runs. Unpaid patient balances picked up by the
            dunning open-scan will appear here.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Active" value={query.data.counts.active} />
            <KpiCard label="Paused" value={query.data.counts.paused} />
            <KpiCard label="At agency" value={query.data.counts.atAgency} />
            <KpiCard
              label="Total balance"
              value={dollars(query.data.counts.totalBalanceCents)}
              tone="gold"
            />
          </div>
          <Card title={`Runs (${query.data.items.length})`}>
            <div className="space-y-2">
              {query.data.items.map((run) => (
                <CollectionsRow
                  key={run.id}
                  run={run}
                  busy={mutation.isPending}
                  onAction={(action) => mutation.mutate({ id: run.id, action })}
                />
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function CollectionsRow({
  run,
  busy,
  onAction,
}: {
  run: CollectionsRun;
  busy: boolean;
  onAction: (action: "pause" | "resolve" | "cancel") => void;
}) {
  return (
    <div
      className="rounded border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="collections-row"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="flex items-center gap-2 text-sm">
          <Badge variant={run.status === "paused" ? "neutral" : "warning"}>
            {run.status === "paused"
              ? `paused${run.paused_reason ? ` · ${run.paused_reason}` : ""}`
              : (STEP_LABEL[run.current_step] ?? run.current_step)}
          </Badge>
          <Link
            href={`/admin/patients/${run.patient_id}`}
            className="font-medium underline"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Patient
          </Link>
          <span className="font-medium" style={{ color: "hsl(var(--ink-1))" }}>
            {dollars(run.opened_balance_cents)}
          </span>
        </span>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {run.next_action_at
            ? `next ${run.next_action_at.slice(0, 10)}`
            : "no next action"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        {run.status === "active" ? (
          <button
            type="button"
            className="rounded border px-2 py-1 disabled:opacity-50"
            style={{ borderColor: "hsl(var(--line-1))" }}
            disabled={busy}
            onClick={() => onAction("pause")}
          >
            Pause
          </button>
        ) : null}
        <button
          type="button"
          className="rounded border px-2 py-1 disabled:opacity-50"
          style={{ borderColor: "hsl(var(--line-1))" }}
          disabled={busy}
          onClick={() => onAction("resolve")}
        >
          Resolve
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 disabled:opacity-50"
          style={{ borderColor: "hsl(var(--line-1))" }}
          disabled={busy}
          onClick={() => onAction("cancel")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
