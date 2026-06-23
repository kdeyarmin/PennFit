// Billing notes for ONE patient — rendered inside PatientBillingTab so a
// biller sees account-specific notes (and can add them) in context, without
// leaving the patient. Backed by the same /admin/billing/notes endpoint
// (migration 0467) as the standalone Billing Notes log, filtered to this
// patient_id. Append-only; the create path logs a structural, non-PHI line
// server-side (never the body).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { formatAppDateTime } from "@/lib/utils";
import {
  type BillingNote,
  type BillingNoteCategory,
  createBillingNote,
  getBillingNotes,
} from "@/lib/admin/billing-notes-api";

const CATEGORIES: { value: BillingNoteCategory; label: string }[] = [
  { value: "patient", label: "Patient" },
  { value: "claims", label: "Claims" },
  { value: "collections", label: "Collections" },
  { value: "payer", label: "Payer" },
  { value: "general", label: "General" },
];

const CATEGORY_LABEL: Record<BillingNoteCategory, string> = {
  claims: "Claims",
  collections: "Collections",
  payer: "Payer",
  patient: "Patient",
  general: "General",
};

export function PatientBillingNotesPanel({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const queryKey = ["patient-billing-notes", patientId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => getBillingNotes({ patientId }),
    staleTime: 15_000,
  });

  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] =
    useState<BillingNoteCategory>("patient");

  const addMut = useMutation({
    mutationFn: () =>
      createBillingNote({
        category: draftCategory,
        body: draft.trim(),
        patientId,
      }),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey });
    },
  });

  const canSubmit = draft.trim().length > 0 && !addMut.isPending;

  return (
    <Card title="Billing notes">
      <div className="space-y-4">
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Account-level billing notes for this patient. For a note about one
          specific claim, use that claim's event log instead.
        </p>

        {/* Compose */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <label
              className="text-xs font-medium"
              style={{ color: "hsl(var(--ink-3))" }}
              htmlFor="patient-billing-note-category"
            >
              Category
            </label>
            <select
              id="patient-billing-note-category"
              className="text-sm rounded border px-2 py-1 bg-transparent"
              style={{ borderColor: "hsl(var(--line-1))" }}
              value={draftCategory}
              onChange={(e) =>
                setDraftCategory(e.target.value as BillingNoteCategory)
              }
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="w-full text-sm rounded border px-3 py-2 bg-transparent min-h-[64px]"
            style={{ borderColor: "hsl(var(--line-1))" }}
            aria-label="Billing note for this patient"
            placeholder="What should the next biller know about this account?"
            maxLength={4000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {draft.length}/4000
            </span>
            <button
              type="button"
              className="text-sm rounded border px-3 py-1.5 disabled:opacity-50"
              style={{ borderColor: "hsl(var(--line-1))" }}
              disabled={!canSubmit}
              onClick={() => addMut.mutate()}
            >
              {addMut.isPending ? "Saving…" : "Add note"}
            </button>
          </div>
          {addMut.isError ? (
            <p className="text-xs" style={{ color: "hsl(354 75% 38%)" }}>
              Couldn't save the note. Try again.
            </p>
          ) : null}
        </div>

        {/* Feed */}
        {query.isPending ? (
          <Spinner label="Loading notes…" />
        ) : query.isError ? (
          <ErrorPanel
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (query.data ?? []).length === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No billing notes for this patient yet.
          </p>
        ) : (
          <div className="space-y-2">
            {(query.data ?? []).map((note) => (
              <NoteRow key={note.id} note={note} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function NoteRow({ note }: { note: BillingNote }) {
  return (
    <div
      className="rounded border p-3 space-y-1"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="patient-billing-note-row"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Badge variant="neutral">{CATEGORY_LABEL[note.category]}</Badge>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {note.authorEmail} · {formatAppDateTime(note.createdAt)}
        </span>
      </div>
      <p
        className="text-sm whitespace-pre-wrap"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {note.body}
      </p>
    </div>
  );
}
