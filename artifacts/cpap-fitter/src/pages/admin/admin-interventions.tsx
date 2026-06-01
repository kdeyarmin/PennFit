// /admin/clinical/interventions — RT non-adherence intervention worklist
// (Phase 3, RT #21).
//
// Every documented adherence intervention, open ones first (outcome
// still pending, soonest follow-up on top). Each row shows the
// structured cause + the plan, links to the patient, and lets the RT
// record the outcome on a re-check. clinical.read to view; the outcome
// update needs clinical.intervention.write (enforced server-side).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Activity } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { Badge } from "@/components/admin/Badge";
import {
  getInterventionWorklist,
  setInterventionOutcome,
  ASSESSMENT_LABEL,
  OUTCOME_STATUSES,
  OUTCOME_LABEL,
  type AssessmentCategory,
  type InterventionItem,
  type OutcomeStatus,
} from "@/lib/admin/interventions-api";

const WINDOWS = [30, 60, 120, 365] as const;
const QUERY_KEY = ["admin", "interventions"] as const;

const OUTCOME_VARIANT: Record<
  OutcomeStatus,
  "info" | "success" | "warning" | "danger" | "muted"
> = {
  pending: "info",
  improved: "success",
  no_change: "warning",
  worsened: "danger",
  unknown: "muted",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString();
}

export function AdminInterventionsPage() {
  const [windowDays, setWindowDays] = useState<number>(120);
  const query = useQuery({
    queryKey: [...QUERY_KEY, windowDays] as const,
    queryFn: () => getInterventionWorklist(windowDays),
    staleTime: 30_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-interventions-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Activity className="h-6 w-6" />
          Adherence interventions
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Why a patient fell off therapy, the plan to recover them, and whether
          it worked. Open interventions (outcome pending) first.
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Time window"
        className="inline-flex gap-1 p-1 rounded-lg bg-slate-100"
      >
        {WINDOWS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === windowDays}
            onClick={() => setWindowDays(d)}
            className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
              d === windowDays
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {d === 365 ? "1 year" : `${d} days`}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Loading interventions…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Open" value={query.data.openCount} tone="gold" />
            <KpiCard label="Total in window" value={query.data.count} />
          </div>

          {query.data.interventions.length === 0 ? (
            <Card>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                No interventions documented in this window.
              </p>
            </Card>
          ) : (
            <Card title={`Worklist (${query.data.interventions.length})`}>
              <div className="space-y-2">
                {query.data.interventions.map((item) => (
                  <InterventionRow key={item.id} item={item} />
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function InterventionRow({ item }: { item: InterventionItem }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (next: OutcomeStatus) => setInterventionOutcome(item.id, next),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div
      className="rounded border p-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="intervention-row"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="flex items-center gap-2 min-w-0">
          <Badge variant={OUTCOME_VARIANT[item.outcomeStatus]}>
            {OUTCOME_LABEL[item.outcomeStatus]}
          </Badge>
          {item.assessmentCategory && (
            <Badge variant="neutral">
              {ASSESSMENT_LABEL[
                item.assessmentCategory as AssessmentCategory
              ] ?? item.assessmentCategory}
            </Badge>
          )}
          <Link
            href={`/admin/patients/${encodeURIComponent(item.patientId)}`}
            className="text-xs underline decoration-dotted font-mono truncate"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {item.patientId}
          </Link>
        </span>
        <span className="flex items-center gap-2">
          {item.followUpAt && (
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              follow-up {formatWhen(item.followUpAt)}
            </span>
          )}
          <select
            value={item.outcomeStatus}
            onChange={(e) => update.mutate(e.target.value as OutcomeStatus)}
            disabled={update.isPending}
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            aria-label="Set intervention outcome"
          >
            {OUTCOME_STATUSES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </span>
      </div>
      {item.plan && (
        <p
          className="text-xs mt-2 whitespace-pre-wrap break-words"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          {item.plan}
        </p>
      )}
    </div>
  );
}
