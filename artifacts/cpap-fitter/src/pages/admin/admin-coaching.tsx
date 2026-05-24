// /admin/coaching — patient adherence outreach workflow.
//
// Renders the open plans queue + a small create form. Per-plan
// state transitions happen inline (chips on each row). Closing a
// plan prompts for a resolution note. Closed plans are hidden
// behind a toggle so the day-to-day view stays tight.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse, Plus } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createCoachingPlan,
  listCoachingPlans,
  patchCoachingPlan,
  type CoachingPlan,
  type CoachingStatus,
} from "@/lib/admin/coaching-plans-api";

const STATUS_TONE: Record<CoachingStatus, string> = {
  open: "bg-amber-100 text-amber-900",
  outreach_made: "bg-blue-100 text-blue-900",
  improving: "bg-emerald-100 text-emerald-900",
  escalated: "bg-rose-100 text-rose-900",
  resolved: "bg-slate-200 text-slate-700",
  abandoned: "bg-slate-200 text-slate-700",
};

const STATUS_LABEL: Record<CoachingStatus, string> = {
  open: "open",
  outreach_made: "outreach made",
  improving: "improving",
  escalated: "escalated",
  resolved: "resolved",
  abandoned: "abandoned",
};

/** Allowed-next-state map for the UI chips. Mirrors the server
 *  rules in lib/coaching/transitions.ts. */
const NEXT_STATES: Record<CoachingStatus, CoachingStatus[]> = {
  open: ["outreach_made", "escalated", "abandoned"],
  outreach_made: ["improving", "escalated", "resolved", "abandoned"],
  improving: ["resolved", "escalated", "abandoned"],
  escalated: ["resolved", "abandoned", "improving"],
  resolved: [],
  abandoned: [],
};

export function AdminCoachingPage() {
  const [showClosed, setShowClosed] = useState(false);
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <HeartPulse className="h-6 w-6" />
            Adherence coaching
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Outreach plans for patients whose CPAP adherence has slipped.
            Each plan layers a state machine on top of a compliance alert
            so surveyors can see "what did we do" — not just "what did
            we notice."
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          Show closed plans
        </label>
      </header>

      <NewPlanCard />
      <PlanListCard showClosed={showClosed} />
    </div>
  );
}

function NewPlanCard() {
  const qc = useQueryClient();
  const [patientId, setPatientId] = useState("");
  const [target, setTarget] = useState("70");
  const create = useMutation({
    mutationFn: () =>
      createCoachingPlan({
        patientId: patientId.trim(),
        targetCompliancePct: Number(target) || 70,
      }),
    onSuccess: () => {
      setPatientId("");
      setTarget("70");
      void qc.invalidateQueries({ queryKey: ["admin", "coaching", "plans"] });
    },
  });

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    patientId.trim(),
  );
  return (
    <Card title="Open a new plan">
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[12rem]">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Patient ID (UUID)
          </label>
          <Input
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-label="Patient ID (UUID)"
            style={{ fontFamily: "monospace" }}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Target %
          </label>
          <Input
            value={target}
            onChange={(e) =>
              setTarget(e.target.value.replace(/\D/g, "").slice(0, 3))
            }
            inputMode="numeric"
            aria-label="Target %"
            style={{ width: "5rem", fontFamily: "monospace" }}
          />
        </div>
        <Button
          disabled={!isUuid || create.isPending}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Open plan
        </Button>
      </div>
      {create.error instanceof Error && (
        <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
          {create.error.message}
        </div>
      )}
    </Card>
  );
}

function PlanListCard({ showClosed }: { showClosed: boolean }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "coaching", "plans", showClosed] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listCoachingPlans(showClosed),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "coaching", "plans"] });
  };

  const plans = useMemo(() => data?.plans ?? [], [data]);
  return (
    <Card title={showClosed ? "All plans" : "Open plans"}>
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : plans.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          Nothing in this view.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left border-b"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <th className="py-2 font-semibold">Patient</th>
              <th className="py-2 font-semibold">Status</th>
              <th className="py-2 font-semibold">Target</th>
              <th className="py-2 font-semibold">Latest</th>
              <th className="py-2 font-semibold">Outreach</th>
              <th className="py-2 font-semibold">Opened</th>
              <th className="py-2 font-semibold">Next moves</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <PlanRow key={p.id} plan={p} onChanged={invalidate} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function PlanRow({
  plan,
  onChanged,
}: {
  plan: CoachingPlan;
  onChanged: () => void;
}) {
  const transition = useMutation({
    mutationFn: async (next: CoachingStatus) => {
      const isTerminal = next === "resolved" || next === "abandoned";
      let resolutionNote: string | null | undefined;
      let latestOutreachAt: string | null | undefined;
      if (isTerminal) {
        const note = window.prompt(
          `Closing the plan as "${next}". Resolution note (required):`,
        );
        if (!note || note.trim().length === 0) {
          throw new Error("A resolution note is required to close a plan.");
        }
        resolutionNote = note;
      } else if (next === "outreach_made") {
        latestOutreachAt = new Date().toISOString();
      }
      return patchCoachingPlan(plan.id, {
        status: next,
        resolutionNote,
        latestOutreachAt,
      });
    },
    onSuccess: onChanged,
  });

  const nexts = NEXT_STATES[plan.status];

  return (
    <tr
      className="border-b align-top"
      style={{ borderColor: "hsl(var(--line-2))" }}
    >
      <td className="py-1.5">
        <a
          href={`/admin/patients/${plan.patientId}`}
          className="font-mono text-xs hover:underline"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          {plan.patientId.slice(0, 8)}
        </a>
      </td>
      <td className="py-1.5">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_TONE[plan.status]}`}
        >
          {STATUS_LABEL[plan.status]}
        </span>
      </td>
      <td className="py-1.5 font-mono tabular-nums">
        {plan.targetCompliancePct}%
      </td>
      <td className="py-1.5 font-mono tabular-nums">
        {plan.latestCompliancePct
          ? `${Math.round(Number(plan.latestCompliancePct))}%`
          : "—"}
      </td>
      <td className="py-1.5 text-xs">
        {plan.latestOutreachAt
          ? new Date(plan.latestOutreachAt).toLocaleDateString()
          : "—"}
      </td>
      <td className="py-1.5 text-xs">
        {new Date(plan.openedAt).toLocaleDateString()}
      </td>
      <td className="py-1.5">
        {nexts.length === 0 ? (
          <span className="text-[10px] text-muted-foreground">closed</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {nexts.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  try {
                    transition.mutate(n);
                  } catch {
                    // prompt-cancel; swallow
                  }
                }}
                disabled={transition.isPending}
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors"
                style={{
                  backgroundColor: "hsl(var(--line-2))",
                  color: "hsl(var(--ink-2))",
                }}
              >
                → {STATUS_LABEL[n]}
              </button>
            ))}
          </div>
        )}
        {transition.error instanceof Error && (
          <div className="mt-1 text-[10px] text-rose-700">
            {transition.error.message}
          </div>
        )}
      </td>
    </tr>
  );
}
