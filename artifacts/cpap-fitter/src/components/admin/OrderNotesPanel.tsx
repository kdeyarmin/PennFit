// Compact CSR-only notes panel for a single shop_order, rendered
// inline under each order row on the customer-360 page (Phase 14).
//
// Why inline-expand and not a per-order detail page:
//   The cash-pay shop_orders surface doesn't have its own admin
//   detail page yet — CSRs land on the customer-360 page and triage
//   from there. Putting the notes inline keeps the entire fulfillment
//   conversation on a single screen without forcing a new route.
//
// Same audit + PHI posture as CustomerNotesPanel: append-only, body
// is plain text, audit envelope is structural-only (order_id +
// body_length).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Spinner } from "@/components/admin/Spinner";
import { Button } from "@/components/admin/Button";
import {
  AdminOrderNotesNotFoundError,
  createAdminOrderNote,
  listAdminOrderNotes,
  type AdminOrderNote,
} from "@/lib/admin/order-notes-api";

interface Props {
  orderId: string;
}

const MAX_BODY = 4000;

export function OrderNotesPanel({ orderId }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryKey = ["admin", "shop", "orders", orderId, "notes"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => listAdminOrderNotes(orderId),
  });

  const mutation = useMutation({
    mutationFn: (body: string) => createAdminOrderNote(orderId, body),
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
      data-testid={`admin-order-notes-${orderId}`}
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
          placeholder="Add an internal note about this order. Visible only to admins."
          aria-label="Order note"
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
          data-testid={`admin-order-notes-input-${orderId}`}
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
            data-testid={`admin-order-notes-submit-${orderId}`}
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
  notes: AdminOrderNote[];
}) {
  if (isPending) {
    return (
      <div style={{ padding: 6 }}>
        <Spinner />
      </div>
    );
  }
  if (isError) {
    if (error instanceof AdminOrderNotesNotFoundError) {
      return (
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: "var(--text-muted, #475569)",
          }}
        >
          Order not found.
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
        No notes yet on this order.
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
