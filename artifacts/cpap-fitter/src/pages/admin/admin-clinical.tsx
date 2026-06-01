// /admin/clinical — clinician portal (F3). Look up a patient, review
// their clinical encounter timeline, and document a new encounter.
//
// Append-only: a correction is a new encounter. Gated server-side on
// clinical.read (view) / clinical.note.write (create); the nav entry is
// hidden for staff without clinical.read.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Stethoscope } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createClinicalEncounter,
  getClinicalEncounters,
  type ClinicalEncounter,
  type EncounterType,
} from "@/lib/admin/clinical-encounters-api";

const ENCOUNTER_LABELS: Record<EncounterType, string> = {
  mask_fit: "Mask fit",
  troubleshoot: "Troubleshoot",
  setup_education: "Setup education",
  adherence_intervention: "Adherence intervention",
  phone: "Phone call",
  other: "Other",
};

export function AdminClinicalPage() {
  const [patientId, setPatientId] = useState("");
  const [active, setActive] = useState<string | null>(null);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Stethoscope className="h-6 w-6" />
          Clinical encounters
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Look up a patient to review their clinical encounter timeline and
          document a new encounter. Encounters are append-only — a correction is
          a new entry.
        </p>
      </header>

      <Card title="Patient">
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[14rem]">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
              Patient ID
            </label>
            <Input
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              placeholder="patient id"
              aria-label="Patient ID"
              style={{ fontFamily: "monospace" }}
            />
          </div>
          <Button
            disabled={patientId.trim().length === 0}
            onClick={() => setActive(patientId.trim() || null)}
          >
            Load encounters
          </Button>
        </div>
      </Card>

      {active && (
        <>
          <NewEncounterCard patientId={active} />
          <EncounterTimeline patientId={active} />
        </>
      )}
    </div>
  );
}

function NewEncounterCard({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const [encounterType, setEncounterType] = useState<EncounterType>("mask_fit");
  const [reason, setReason] = useState("");
  const [assessment, setAssessment] = useState("");
  const [intervention, setIntervention] = useState("");
  const [plan, setPlan] = useState("");
  const [note, setNote] = useState("");

  const hasContent = [reason, assessment, intervention, plan, note].some(
    (s) => s.trim().length > 0,
  );

  const create = useMutation({
    mutationFn: () =>
      createClinicalEncounter(patientId, {
        encounterType,
        reason: reason.trim() || undefined,
        assessment: assessment.trim() || undefined,
        intervention: intervention.trim() || undefined,
        plan: plan.trim() || undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setReason("");
      setAssessment("");
      setIntervention("");
      setPlan("");
      setNote("");
      void qc.invalidateQueries({
        queryKey: ["admin", "clinical", "encounters", patientId],
      });
    },
  });

  return (
    <Card title="Document an encounter">
      <div className="space-y-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Type
          </label>
          <select
            className="w-full rounded border px-3 py-2 text-sm"
            value={encounterType}
            onChange={(e) => setEncounterType(e.target.value as EncounterType)}
            aria-label="Encounter type"
          >
            {(Object.keys(ENCOUNTER_LABELS) as EncounterType[]).map((t) => (
              <option key={t} value={t}>
                {ENCOUNTER_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <EncounterField
          label="Reason / chief complaint"
          value={reason}
          onChange={setReason}
        />
        <EncounterField
          label="Assessment"
          value={assessment}
          onChange={setAssessment}
        />
        <EncounterField
          label="Intervention"
          value={intervention}
          onChange={setIntervention}
        />
        <EncounterField
          label="Plan / follow-up"
          value={plan}
          onChange={setPlan}
        />
        <EncounterField label="Note" value={note} onChange={setNote} rows={3} />

        <div className="flex items-center gap-3">
          <Button
            disabled={!hasContent || create.isPending}
            isLoading={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="h-4 w-4 mr-1" />
            Save encounter
          </Button>
          {!hasContent && (
            <span className="text-xs text-muted-foreground">
              Add a note or at least one field.
            </span>
          )}
        </div>
        {create.error instanceof Error && (
          <div className="mt-1 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
            {create.error.message}
          </div>
        )}
      </div>
    </Card>
  );
}

function EncounterField({
  label,
  value,
  onChange,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
        {label}
      </label>
      <textarea
        className="w-full rounded border px-3 py-2 text-sm"
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
    </div>
  );
}

function EncounterTimeline({ patientId }: { patientId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "clinical", "encounters", patientId] as const,
    queryFn: () => getClinicalEncounters(patientId),
  });
  const encounters = useMemo(() => data?.encounters ?? [], [data]);

  return (
    <Card title="Encounter timeline">
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : encounters.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No encounters recorded for this patient yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {encounters.map((enc) => (
            <EncounterRow key={enc.id} encounter={enc} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function EncounterRow({ encounter }: { encounter: ClinicalEncounter }) {
  return (
    <li className="rounded border p-3 text-sm">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="font-semibold">
          {ENCOUNTER_LABELS[encounter.encounterType]}
        </span>
        <span className="text-xs text-muted-foreground">
          {new Date(encounter.createdAt).toLocaleString()} ·{" "}
          {encounter.authorEmail}
        </span>
      </div>
      <dl className="mt-2 space-y-1">
        {encounter.reason && (
          <EncounterDetail label="Reason" value={encounter.reason} />
        )}
        {encounter.assessment && (
          <EncounterDetail label="Assessment" value={encounter.assessment} />
        )}
        {encounter.intervention && (
          <EncounterDetail
            label="Intervention"
            value={encounter.intervention}
          />
        )}
        {encounter.plan && (
          <EncounterDetail label="Plan" value={encounter.plan} />
        )}
        {encounter.note && (
          <EncounterDetail label="Note" value={encounter.note} />
        )}
      </dl>
    </li>
  );
}

function EncounterDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground min-w-[5.5rem] pt-0.5">
        {label}
      </dt>
      <dd className="flex-1 whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
