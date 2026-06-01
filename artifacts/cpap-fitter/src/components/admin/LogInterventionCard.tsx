// RT #21 — log a structured non-adherence intervention from the patient
// page. Records the structured cause + the recovery plan; persists as a
// clinical_encounters row of type 'adherence_intervention' (so it shows
// in the patient timeline and the interventions worklist).
//
// Permission-gated client-side (clinical.intervention.write) so it only
// appears for RTs / management — the backend enforces the same gate.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity } from "lucide-react";

import { useGetAdminMe } from "@workspace/api-client-react/admin";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import {
  createIntervention,
  ASSESSMENT_CATEGORIES,
  ASSESSMENT_LABEL,
  type AssessmentCategory,
} from "@/lib/admin/interventions-api";

export function LogInterventionCard({ patientId }: { patientId: string }) {
  const adminMe = useGetAdminMe();
  const canWrite = (adminMe.data?.permissions ?? []).includes(
    "clinical.intervention.write",
  );

  const [category, setCategory] = useState<AssessmentCategory>("mask_leak");
  const [plan, setPlan] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [done, setDone] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      createIntervention(patientId, {
        assessmentCategory: category,
        plan: plan.trim() || undefined,
        followUpAt: followUp ? new Date(followUp).toISOString() : undefined,
      }),
    onSuccess: () => {
      setDone(true);
      setPlan("");
      setFollowUp("");
      setCategory("mask_leak");
    },
  });

  // Hidden entirely for roles without the clinical write permission.
  if (!canWrite) return null;

  return (
    <Card
      title="Log an intervention"
      subtitle="Capture why therapy slipped and the plan to recover it — tracked to an outcome."
    >
      <div
        className="flex flex-wrap items-end gap-2"
        data-testid="log-intervention"
      >
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Cause
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as AssessmentCategory)}
            className="rounded border border-slate-300 px-2 py-2 text-sm"
            aria-label="Assessment category"
          >
            {ASSESSMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ASSESSMENT_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="block flex-1 min-w-[16rem]">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Plan
          </span>
          <input
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            placeholder="e.g. Trial nasal pillow mask; re-check usage in 2 weeks"
            aria-label="Intervention plan"
            maxLength={4000}
            className="w-full rounded border border-slate-300 px-2 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Follow-up
          </span>
          <input
            type="date"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            aria-label="Follow-up date"
            className="rounded border border-slate-300 px-2 py-2 text-sm"
          />
        </label>
        <Button
          isLoading={create.isPending}
          onClick={() => {
            setDone(false);
            create.mutate();
          }}
        >
          <Activity className="h-4 w-4 mr-1" />
          Log intervention
        </Button>
      </div>
      {create.error instanceof Error && (
        <p className="mt-2 text-sm" style={{ color: "#b91c1c" }} role="alert">
          Couldn&apos;t save the intervention.
        </p>
      )}
      {done && (
        <p className="mt-2 text-sm" style={{ color: "#166534" }} role="status">
          Intervention logged — track its outcome on the Interventions page.
        </p>
      )}
    </Card>
  );
}
