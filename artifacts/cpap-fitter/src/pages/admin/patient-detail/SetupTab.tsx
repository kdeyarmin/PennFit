// Setup tab on the patient chart. The first-night checklist is what
// finishes a new CPAP setup. Dispense readiness for E0601 and the
// manual Medicare same-or-similar record sit under it. HETS is not
// called from here: a person records what the portal showed.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/admin/Button";
import { Spinner } from "@/components/admin/Spinner";
import { formatDateTime } from "@/lib/admin/format";
import {
  fetchDispenseReviews,
  fetchSameOrSimilar,
  fetchSetupChecklist,
  putSetupChecklistStep,
  recordSameOrSimilar,
  runDispenseReadiness,
  type SameOrSimilarCheck,
  type SetupChecklistStep,
} from "@/lib/admin/patient-setup-chart-api";

const CHECKLIST_STATUSES: SetupChecklistStep["status"][] = [
  "pending",
  "done",
  "na",
];

function FirstNightChecklist({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const checklistKey = [
    "admin",
    "patients",
    patientId,
    "setup-checklist",
  ] as const;
  const checklist = useQuery({
    queryKey: checklistKey,
    queryFn: () => fetchSetupChecklist(patientId),
  });
  const save = useMutation({
    mutationFn: (input: {
      stepKey: string;
      status: SetupChecklistStep["status"];
    }) => putSetupChecklistStep(patientId, input.stepKey, input.status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: checklistKey });
      void queryClient.invalidateQueries({ queryKey: ["admin", "setups"] });
    },
  });

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">First night</h3>
        <p className="text-xs text-muted-foreground mt-1">
          The setup stays open until the machine has shipped and every step here
          is done or not applicable.
        </p>
      </div>
      {checklist.isPending ? (
        <Spinner label="Loading checklist…" />
      ) : checklist.isError ? (
        <p className="text-sm text-destructive">
          Could not load the checklist.
        </p>
      ) : (
        <ul className="space-y-2">
          {(checklist.data ?? []).map((step) => (
            <li
              key={step.stepKey}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-sm">{step.label}</span>
              <select
                aria-label={step.label}
                className="text-sm border rounded px-2 py-1"
                value={
                  CHECKLIST_STATUSES.includes(step.status)
                    ? step.status
                    : "pending"
                }
                disabled={save.isPending}
                onChange={(event) =>
                  save.mutate({
                    stepKey: step.stepKey,
                    status: event.target.value as SetupChecklistStep["status"],
                  })
                }
              >
                <option value="pending">Pending</option>
                <option value="done">Done</option>
                <option value="na">Not applicable</option>
              </select>
            </li>
          ))}
        </ul>
      )}
      {save.isError && (
        <p className="text-sm text-destructive">
          {save.error instanceof Error
            ? save.error.message
            : "Could not save the step."}
        </p>
      )}
    </section>
  );
}

const STATUSES: SameOrSimilarCheck["status"][] = [
  "clear",
  "inactive",
  "active",
  "unknown",
];

export function SetupTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const reviewsKey = [
    "admin",
    "patients",
    patientId,
    "dispense-readiness",
  ] as const;
  const similarKey = [
    "admin",
    "patients",
    patientId,
    "same-or-similar",
  ] as const;

  const reviews = useQuery({
    queryKey: reviewsKey,
    queryFn: () => fetchDispenseReviews(patientId),
  });
  const similar = useQuery({
    queryKey: similarKey,
    queryFn: () => fetchSameOrSimilar(patientId),
  });

  const run = useMutation({
    mutationFn: () => runDispenseReadiness(patientId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewsKey });
    },
  });

  const [status, setStatus] = useState<SameOrSimilarCheck["status"]>("clear");
  const [lastDispenseOn, setLastDispenseOn] = useState("");
  const [notes, setNotes] = useState("");

  const record = useMutation({
    mutationFn: () =>
      recordSameOrSimilar(patientId, {
        status,
        lastDispenseOn: lastDispenseOn.trim() || null,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      setNotes("");
      void queryClient.invalidateQueries({ queryKey: similarKey });
    },
  });

  const latest = reviews.data?.[0];
  const e0601 = (similar.data ?? []).filter(
    (row) => row.hcpcs_code === "E0601",
  );

  return (
    <div className="space-y-6">
      <FirstNightChecklist patientId={patientId} />
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold">Dispense readiness, E0601</h3>
            <p className="text-xs text-muted-foreground mt-1">
              The check the board uses before a machine is promised. It does not
              place an order.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => run.mutate()}
            disabled={run.isPending}
          >
            {run.isPending ? "Checking…" : "Run E0601 check"}
          </Button>
        </div>
        {run.isError && (
          <p className="text-sm text-destructive">
            {run.error instanceof Error
              ? run.error.message
              : "The readiness check failed."}
          </p>
        )}
        {run.data && (
          <p className="text-sm">
            {run.data.readyToDispense
              ? "Ready to dispense."
              : `Not ready (${run.data.overallVerdict.replaceAll("_", " ")}).`}
            {run.data.findings
              .filter(
                (finding) =>
                  finding.blocksDispense || finding.severity === "error",
              )
              .slice(0, 4)
              .map((finding) => ` ${finding.label}.`)}
          </p>
        )}
        {reviews.isPending ? (
          <Spinner label="Loading readiness…" />
        ) : reviews.isError ? (
          <p className="text-sm text-destructive">
            Could not load readiness reviews.
          </p>
        ) : latest ? (
          <p className="text-sm text-muted-foreground">
            Latest: {latest.overall_verdict.replaceAll("_", " ")} on{" "}
            {formatDateTime(latest.created_at)}. {latest.checks_passed} passed,{" "}
            {latest.checks_failed} failed.
            {latest.ai_summary ? ` ${latest.ai_summary}` : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No readiness review yet.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">
            Medicare same-or-similar, E0601
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Record what the HETS portal showed. This does not call Medicare. An
            active hit means do not promise a machine.
          </p>
        </div>
        {similar.isPending ? (
          <Spinner label="Loading same-or-similar…" />
        ) : similar.isError ? (
          <p className="text-sm text-destructive">
            Could not load same-or-similar records.
          </p>
        ) : e0601.length === 0 ? (
          <p className="text-sm text-muted-foreground">No E0601 record yet.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {e0601.slice(0, 5).map((row) => (
              <li key={row.id}>
                {row.status}
                {row.last_dispense_on
                  ? `, last dispense ${row.last_dispense_on}`
                  : ""}
                {" · "}
                {formatDateTime(row.checked_at)}
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            record.mutate();
          }}
        >
          <label className="text-xs space-y-1">
            <span className="block">Result</span>
            <select
              className="text-sm border rounded px-2 py-1"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as SameOrSimilarCheck["status"])
              }
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span className="block">Last dispense</span>
            <input
              type="date"
              className="text-sm border rounded px-2 py-1"
              value={lastDispenseOn}
              onChange={(event) => setLastDispenseOn(event.target.value)}
            />
          </label>
          <label className="text-xs space-y-1 flex-1 min-w-[12rem]">
            <span className="block">Notes</span>
            <input
              className="text-sm border rounded px-2 py-1 w-full"
              value={notes}
              maxLength={500}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Portal ticket or what you saw"
            />
          </label>
          <Button type="submit" size="sm" disabled={record.isPending}>
            {record.isPending ? "Saving…" : "Record"}
          </Button>
        </form>
        {record.isError && (
          <p className="text-sm text-destructive">
            {record.error instanceof Error
              ? record.error.message
              : "Could not record the check."}
          </p>
        )}
      </section>
    </div>
  );
}
