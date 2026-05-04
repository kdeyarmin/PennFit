// CSR-authored internal notes panel for the customer-360 page
// (Phase 10).
//
// Mirrors the patient-notes pattern (composer at the top, newest-
// first list below). Append-only — no edit/delete in v1; the audit
// log records every write as `shop_customer.note.create` so any
// future correction is a new note that explains the prior one.
//
// PHI posture: notes can contain anything the CSR types. The
// browser surface renders them in plaintext under the requireAdmin
// gate; we never log the body to the console / analytics.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StickyNote } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { Button } from "@/components/admin/Button";
import {
  AdminCustomerNotesNotFoundError,
  createAdminCustomerNote,
  listAdminCustomerNotes,
  type AdminCustomerNote,
} from "@/lib/admin/customer-notes-api";

interface Props {
  userId: string;
}

const MAX_BODY = 4000;

export function CustomerNotesPanel({ userId }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryKey = ["admin", "shop", "customers", userId, "notes"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => listAdminCustomerNotes(userId),
  });

  const mutation = useMutation({
    mutationFn: (body: string) => createAdminCustomerNote(userId, body),
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
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-notes">
        <h2
          style={{
            margin: 0,
            fontSize: 14,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <StickyNote size={14} />
          Internal notes
        </h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            mutation.mutate(draft.trim());
          }}
          style={{ display: "grid", gap: 8, marginBottom: 16 }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note for the team. Visible only to admins."
            rows={3}
            maxLength={MAX_BODY + 200}
            disabled={mutation.isPending}
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid var(--border, #e2e8f0)",
              borderRadius: 6,
              fontFamily: "inherit",
              fontSize: 13,
              resize: "vertical",
            }}
            data-testid="admin-customer-notes-input"
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
                fontSize: 11,
                color: overLimit ? "#dc2626" : "var(--text-muted, #475569)",
              }}
              data-testid="admin-customer-notes-counter"
            >
              {trimmedLen}/{MAX_BODY}
            </span>
            <Button
              type="submit"
              disabled={!canSubmit}
              data-testid="admin-customer-notes-submit"
            >
              {mutation.isPending ? "Saving…" : "Add note"}
            </Button>
          </div>
          {submitError && (
            <p
              style={{ margin: 0, fontSize: 12, color: "#dc2626" }}
              data-testid="admin-customer-notes-error"
            >
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
    </Card>
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
  notes: AdminCustomerNote[];
}) {
  if (isPending) {
    return (
      <div style={{ padding: 12 }}>
        <Spinner />
      </div>
    );
  }
  if (isError) {
    if (error instanceof AdminCustomerNotesNotFoundError) {
      return (
        <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>
          Customer not found.
        </p>
      );
    }
    return (
      <p
        style={{ margin: 0, color: "#dc2626" }}
        data-testid="admin-customer-notes-list-error"
      >
        Failed to load notes.
      </p>
    );
  }
  if (notes.length === 0) {
    return (
      <p
        style={{ margin: 0, color: "var(--text-muted, #475569)", fontSize: 13 }}
        data-testid="admin-customer-notes-empty"
      >
        No notes yet. Add one above to start a paper trail.
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
        gap: 8,
      }}
      data-testid="admin-customer-notes-list"
    >
      {notes.map((n) => (
        <li
          key={n.id}
          style={{
            padding: 10,
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            background: "#fffbe6",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted, #475569)",
              marginBottom: 4,
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span>{n.authorEmail}</span>
            <span>·</span>
            <span title={n.createdAt}>
              {new Date(n.createdAt).toLocaleString()}
            </span>
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{n.body}</div>
        </li>
      ))}
    </ul>
  );
}
