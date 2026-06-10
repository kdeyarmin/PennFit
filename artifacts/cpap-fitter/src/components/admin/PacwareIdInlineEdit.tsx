// Inline editor for the PacWare account number in the patient-detail
// header. This is the backfill path for patients created before
// PacWare knew them (pacware_id is nullable since migration 0303):
// once the account exists in PacWare, the admin sets the id here so
// roster imports correlate with this chart instead of inserting a
// duplicate patient.
//
// Behaviour mirrors SettingsCard's PATCH semantics: the save sends
// `expectedUpdatedAt` (optimistic concurrency — a stale row 409s and
// we refetch), blank clears to null, and a duplicate id surfaces the
// server's 409 `duplicate_pacware_id` message inline so the admin can
// correct it without losing the edit.

import { useEffect, useState } from "react";

import {
  ApiError,
  useUpdatePatient,
  type PatientDetail,
} from "@workspace/api-client-react/admin";

export function PacwareIdInlineEdit({
  patient,
  onSaved,
}: {
  patient: PatientDetail;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(patient.pacwareId ?? "");
  const [error, setError] = useState<string | null>(null);
  const mutation = useUpdatePatient();
  const isPending = mutation.isPending;

  // Re-seed the draft whenever the row refetches (a save elsewhere on
  // the page, or the stale-409 refresh below) so we never show a value
  // the server has since replaced.
  useEffect(() => {
    setDraft(patient.pacwareId ?? "");
  }, [patient.pacwareId]);

  function startEditing() {
    setDraft(patient.pacwareId ?? "");
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setDraft(patient.pacwareId ?? "");
    setError(null);
    setEditing(false);
  }

  async function save() {
    setError(null);
    const trimmed = draft.trim();
    if (trimmed === (patient.pacwareId ?? "")) {
      setEditing(false);
      return;
    }
    try {
      await mutation.mutateAsync({
        id: patient.id,
        data: {
          pacwareId: trimmed === "" ? null : trimmed,
          expectedUpdatedAt: patient.updatedAt,
        },
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const data = err.data as
          | { error?: string; message?: string }
          | undefined;
        if (data?.error === "duplicate_pacware_id") {
          // Stay in edit mode so the admin can correct the id.
          setError(data.message ?? "That PacWare ID is already in use.");
          return;
        }
        setError(
          "This patient was changed by someone else since you opened it. Refreshing — please retry.",
        );
        setEditing(false);
        onSaved();
        return;
      }
      if (err instanceof ApiError) {
        const data = err.data as
          | { error?: string; message?: string }
          | undefined;
        setError(
          data?.message ?? data?.error ?? "Couldn't save the PacWare ID.",
        );
        return;
      }
      setError(
        err instanceof Error ? err.message : "Couldn't save the PacWare ID.",
      );
    }
  }

  if (!editing) {
    return (
      <span>
        {patient.pacwareId
          ? `PACware ID #${patient.pacwareId}`
          : "No PacWare ID"}{" "}
        <button
          type="button"
          className="underline decoration-dotted"
          style={{ color: "hsl(var(--ink-3))" }}
          onClick={startEditing}
        >
          {patient.pacwareId ? "Edit" : "Add"}
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        aria-label="PacWare ID"
        className="w-36 rounded border px-1.5 py-0.5 text-xs"
        style={{
          borderColor: "hsl(var(--line-1))",
          color: "hsl(var(--ink-1))",
        }}
        value={draft}
        maxLength={64}
        placeholder="PacWare account #"
        autoFocus
        disabled={isPending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape" && !isPending) {
            cancel();
          }
        }}
      />
      <button
        type="button"
        className="underline decoration-dotted"
        style={{ color: "hsl(var(--ink-1))" }}
        onClick={() => void save()}
        disabled={isPending}
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        className="underline decoration-dotted"
        style={{ color: "hsl(var(--ink-3))" }}
        onClick={cancel}
        disabled={isPending}
      >
        Cancel
      </button>
      {error && (
        <span role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </span>
      )}
    </span>
  );
}
