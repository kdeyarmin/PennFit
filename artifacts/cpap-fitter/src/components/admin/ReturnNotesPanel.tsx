// Compact CSR-only notes panel for a single shop_return row,
// rendered inline inside each return card on /admin/shop/returns
// (Phase 15). Mirrors OrderNotesPanel.
//
// Why per-return notes when shop_returns already has an `adminNote`
// column: the column is a single text blob mutated alongside status
// transitions (approve/reject/refund). It conflates "decision
// rationale" with "ad-hoc CSR observation". The shop_return_notes
// table is an append-only log of arbitrary internal commentary
// independent of state changes — vendor responses, follow-up
// reminders, escalation context — without overwriting prior notes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Spinner } from "@/components/admin/Spinner";
import { Button } from "@/components/admin/Button";
import {
  AdminReturnNotesNotFoundError,
  createAdminReturnNote,
  listAdminReturnNotes,
  type AdminReturnNote,
} from "@/lib/admin/return-notes-api";

interface Props {
  returnId: string;
}

const MAX_BODY = 4000;

export function ReturnNotesPanel({ returnId }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryKey = ["admin", "shop", "returns", returnId, "notes"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => listAdminReturnNotes(returnId),
  });

  const mutation = useMutation({
    mutationFn: (body: string) => createAdminReturnNote(returnId, body),
    onSuccess: () => {
      setDraft("");
      setSubmitError(null);
      void qc.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to save note.",
      );
    },
  });

  const trimmedLen = draft.trim().length;
  const overLimit = trimmedLen > MAX_BODY;
  const canSubmit = trimmedLen > 0 && !overLimit && !mutation.isPending;

  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: 6,
        background: "#fafbfc",
      }}
      data-testid={`admin-return-notes-${returnId}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          mutation.mutate(draft.trim());
        }}
        style={{ display: "grid", gap: 6, marginBottom: 10 }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add an internal note about this return. Visible only to admins."
          aria-label="Return note"
          rows={2}
          maxLength={MAX_BODY + 200}
          disabled={mutation.isPending}
          style={{
            width: "100%",
            padding: 6,
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 4,
            fontFamily: "inherit",
            fontSize: 12,
            resize: "vertical",
          }}
          data-testid={`admin-return-notes-input-${returnId}`}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: overLimit ? "#dc2626" : "var(--text-muted, #475569)",
            }}
          >
            {trimmedLen}/{MAX_BODY}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            data-testid={`admin-return-notes-submit-${returnId}`}
          >
            {mutation.isPending ? "Saving…" : "Add note"}
          </Button>
        </div>
        {submitError && (
          <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>
            {submitError}
          </p>
        )}
      </form>

      <NotesList
        isPending={isPending}
        isError={isError}
        error={error}
        notes={data?.notes ?? []}
      />
    </div>
  );
}

function NotesList({
  isPending,
  isError,
  error,
  notes,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  notes: AdminReturnNote[];
}) {
  if (isPending) {
    return (
      <div style={{ padding: 6 }}>
        <Spinner />
      </div>
    );
  }
  if (isError) {
    if (error instanceof AdminReturnNotesNotFoundError) {
      return (
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: "var(--text-muted, #475569)",
          }}
        >
          Return not found.
        </p>
      );
    }
    return (
      <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>
        Failed to load notes.
      </p>
    );
  }
  if (notes.length === 0) {
    return (
      <p
        style={{ margin: 0, fontSize: 11, color: "var(--text-muted, #475569)" }}
      >
        No notes yet on this return.
      </p>
    );
  }
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "grid",
        gap: 6,
      }}
    >
      {notes.map((n) => (
        <li
          key={n.id}
          style={{
            padding: 8,
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 4,
            background: "#fffbe6",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted, #475569)",
              marginBottom: 3,
            }}
          >
            {n.authorEmail} · {new Date(n.createdAt).toLocaleString()}
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{n.body}</div>
        </li>
      ))}
    </ul>
  );
}
