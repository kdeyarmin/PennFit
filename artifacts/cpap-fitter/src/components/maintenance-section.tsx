import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Check, Droplets, Filter, Wind } from "lucide-react";

import {
  fetchMaintenanceSummary,
  logMaintenanceTask,
  type MaintenanceCategory,
  type MaintenanceDueBucket,
  type MaintenanceTask,
} from "@/lib/account-api";

/**
 * "Hygiene maintenance" section on /account.
 *
 * Surfaces the patient's manufacturer-recommended cleaning cadence
 * — daily mask wipe-down, weekly hose flush, monthly filter swap,
 * etc. — with a one-click checkbox UI that logs completion to
 * patient_maintenance_log.
 *
 * Hides itself entirely when the server reports no patient match
 * (anonymous shop customer, or email not linked to a patient row),
 * mirroring TherapySummarySection.
 *
 * Why this lives on /account and not behind a separate route:
 * the checklist's value is *adjacent* to the therapy data —
 * patients who see "my AHI crept up this week" should see "and
 * here's the hose I haven't washed for 9 days" right next to it.
 */
export function MaintenanceSection() {
  const queryKey = ["account", "maintenance"] as const;
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: fetchMaintenanceSummary,
  });

  if (isLoading) return null;
  if (!data || !data.patientLinked) return null;

  const dueNow = data.tasks.filter((t) => t.bucket === "due_now").length;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-maintenance"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
          <h2 className="font-semibold">Hygiene checklist</h2>
        </div>
        {dueNow > 0 && (
          <span className="text-xs rounded-full bg-amber-100 text-amber-900 px-2 py-0.5">
            {dueNow} due today
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Manufacturer-recommended cleaning cadence. Check the box once
        you&rsquo;ve done it and the next-due date rolls forward.
      </p>
      <ul className="space-y-2">
        {data.tasks.map((task) => (
          <MaintenanceRow
            key={task.key}
            task={task}
            onLogged={() => {
              void qc.invalidateQueries({ queryKey });
            }}
          />
        ))}
      </ul>
    </section>
  );
}

const BUCKET_TONE: Record<
  MaintenanceDueBucket,
  { border: string; text: string; chip: string }
> = {
  due_now: {
    border: "hsl(0 70% 80%)",
    text: "hsl(0 70% 35%)",
    chip: "bg-rose-100 text-rose-900",
  },
  due_soon: {
    border: "hsl(35 75% 80%)",
    text: "hsl(35 75% 35%)",
    chip: "bg-amber-100 text-amber-900",
  },
  current: {
    border: "hsl(var(--line-1))",
    text: "hsl(var(--ink-3))",
    chip: "bg-emerald-100 text-emerald-900",
  },
};

const CATEGORY_ICON: Record<MaintenanceCategory, React.ReactNode> = {
  mask: <Wind className="h-4 w-4" />,
  tubing: <Wind className="h-4 w-4" />,
  humidifier: <Droplets className="h-4 w-4" />,
  filter: <Filter className="h-4 w-4" />,
};

function MaintenanceRow({
  task,
  onLogged,
}: {
  task: MaintenanceTask;
  onLogged: () => void;
}) {
  const [justLogged, setJustLogged] = useState(false);
  const log = useMutation({
    mutationFn: () => logMaintenanceTask(task.key),
    onSuccess: () => {
      setJustLogged(true);
      // Brief animation; the query invalidation will swap the row
      // shortly. setTimeout out of the success path keeps the
      // success spinner visible until the new data lands.
      setTimeout(() => setJustLogged(false), 1200);
      onLogged();
    },
  });
  const tone = BUCKET_TONE[task.bucket];
  return (
    <li
      className="rounded-xl border p-3 flex items-center gap-3"
      style={{ borderColor: tone.border }}
    >
      <button
        type="button"
        onClick={() => log.mutate()}
        disabled={log.isPending || justLogged}
        className="h-7 w-7 rounded-full border flex items-center justify-center shrink-0 transition-colors"
        style={{
          borderColor: tone.border,
          backgroundColor: justLogged ? "hsl(var(--penn-gold))" : "transparent",
        }}
        aria-label={`Mark ${task.label} done`}
      >
        {justLogged ? (
          <Check className="h-4 w-4 text-white" />
        ) : log.isPending ? (
          <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {CATEGORY_ICON[task.category]}
          </span>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{task.label}</div>
        <div className="text-xs text-muted-foreground">{task.why}</div>
      </div>
      <div className="text-right shrink-0">
        <div
          className={`inline-block text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${tone.chip}`}
        >
          {bucketLabel(task)}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {task.lastCompletedAt
            ? `Last: ${new Date(task.lastCompletedAt).toLocaleDateString()}`
            : "Never done"}
        </div>
      </div>
    </li>
  );
}

function bucketLabel(task: MaintenanceTask): string {
  if (task.bucket === "due_now") {
    return task.daysUntilDue < 0
      ? `${Math.abs(task.daysUntilDue)}d overdue`
      : "Due today";
  }
  if (task.bucket === "due_soon") return "Due tomorrow";
  return `Next ${new Date(task.nextDueDate).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}
