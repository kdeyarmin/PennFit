// CSR-scheduled callback / check-back reminders panel for the
// customer-360 page (Phase 17).
//
// Two stacked sections:
//   1. Composer: short body + a date/time picker, defaulting the
//      due-at to "tomorrow at 9am customer-local-ish" so the common
//      case is one click. Anything farther out is two extra clicks.
//   2. Open queue: ascending due_at — most overdue first. Each row
//      has a one-click "Mark complete" that posts the PATCH and
//      removes the row from the open list.
//
// Same audit + PHI posture as the notes panels: bodies are plain
// text and never enter the audit envelope.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CalendarClock, CheckCircle2 } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { Button } from "@/components/admin/Button";
import {
  AdminCustomerFollowupsNotFoundError,
  completeAdminCustomerFollowup,
  createAdminCustomerFollowup,
  listAdminCustomerFollowups,
  type AdminCustomerFollowup,
} from "@/lib/admin/customer-followups-api";

interface Props {
  userId: string;
}

const MAX_BODY = 2000;

export function CustomerFollowupsPanel({ userId }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [dueLocal, setDueLocal] = useState(defaultDueLocal());
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryKey = ["admin", "shop", "customers", userId, "followups"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => listAdminCustomerFollowups(userId),
  });

  const createMutation = useMutation({
    mutationFn: ({ body, dueAt }: { body: string; dueAt: Date }) =>
      createAdminCustomerFollowup(userId, body, dueAt),
    onSuccess: () => {
      setDraft("");
      setDueLocal(defaultDueLocal());
      setSubmitError(null);
      void qc.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to schedule followup.",
      );
    },
  });

  const completeMutation = useMutation({
    mutationFn: (followupId: string) =>
      completeAdminCustomerFollowup(userId, followupId),
    onSuccess: () => {
      setSubmitError(null);
    },
    onError: (err) => {
      if (
        err instanceof AdminCustomerFollowupsNotFoundError ||
        (err instanceof Error &&
          (err.message.includes("404") || err.message.includes("409")))
      ) {
        setSubmitError(
          "This followup was already completed or no longer exists. Refreshing the list.",
        );
        return;
      }

      setSubmitError(
        err instanceof Error ? err.message : "Failed to complete followup.",
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });

  const trimmedLen = draft.trim().length;
  const overLimit = trimmedLen > MAX_BODY;
  const dueAtParsed = parseLocal(dueLocal);
  const validDate = dueAtParsed !== null && !isNaN(dueAtParsed.getTime());
  const canSubmit =
    trimmedLen > 0 && !overLimit && validDate && !createMutation.isPending;

  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-followups">
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
          <CalendarClock size={14} />
          Follow-ups
        </h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit || dueAtParsed === null) return;
            createMutation.mutate({ body: draft.trim(), dueAt: dueAtParsed });
          }}
          style={{ display: "grid", gap: 8, marginBottom: 16 }}
        >
          <textarea
            aria-label="Follow-up details"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What do you need to do (e.g. 'Call about UPS claim status')?"
            rows={2}
            maxLength={MAX_BODY + 200}
            disabled={createMutation.isPending}
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid var(--border, #e2e8f0)",
              borderRadius: 6,
              fontFamily: "inherit",
              fontSize: 13,
              resize: "vertical",
            }}
            data-testid="admin-customer-followups-body"
          />
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <label
              htmlFor="followup-due-at"
              style={{
                fontSize: 11,
                color: "var(--text-muted, #475569)",
              }}
            >
              Due
            </label>
            <input
              id="followup-due-at"
              type="datetime-local"
              value={dueLocal}
              onChange={(e) => setDueLocal(e.target.value)}
              disabled={createMutation.isPending}
              style={{
                padding: "4px 6px",
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 4,
                fontSize: 12,
              }}
              data-testid="admin-customer-followups-due"
            />
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11,
                color: overLimit ? "#dc2626" : "var(--text-muted, #475569)",
              }}
            >
              {trimmedLen}/{MAX_BODY}
            </span>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              data-testid="admin-customer-followups-submit"
            >
              {createMutation.isPending ? "Saving…" : "Schedule"}
            </Button>
          </div>
          {submitError && (
            <p style={{ margin: 0, fontSize: 12, color: "#dc2626" }}>
              {submitError}
            </p>
          )}
        </form>

        <FollowupsList
          isPending={isPending}
          isError={isError}
          error={error}
          followups={data?.followups ?? []}
          onComplete={(id) => completeMutation.mutate(id)}
          completingId={
            completeMutation.isPending
              ? ((completeMutation.variables as string | undefined) ?? null)
              : null
          }
        />
      </div>
    </Card>
  );
}

function FollowupsList({
  isPending,
  isError,
  error,
  followups,
  onComplete,
  completingId,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  followups: AdminCustomerFollowup[];
  onComplete: (id: string) => void;
  completingId: string | null;
}) {
  if (isPending) {
    return (
      <div style={{ padding: 12 }}>
        <Spinner />
      </div>
    );
  }
  if (isError) {
    if (error instanceof AdminCustomerFollowupsNotFoundError) {
      return (
        <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>
          Customer not found.
        </p>
      );
    }
    return (
      <p style={{ margin: 0, color: "#dc2626", fontSize: 12 }}>
        Failed to load follow-ups.
      </p>
    );
  }
  if (followups.length === 0) {
    return (
      <p
        style={{ margin: 0, color: "var(--text-muted, #475569)", fontSize: 13 }}
        data-testid="admin-customer-followups-empty"
      >
        No open follow-ups. Schedule one above to commit to a callback.
      </p>
    );
  }
  const now = Date.now();
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "grid",
        gap: 8,
      }}
      data-testid="admin-customer-followups-list"
    >
      {followups.map((f) => {
        const due = new Date(f.dueAt).getTime();
        const overdue = due < now;
        return (
          <li
            key={f.id}
            style={{
              padding: 10,
              border: `1px solid ${overdue ? "#fecaca" : "var(--border, #e2e8f0)"}`,
              borderRadius: 6,
              background: overdue ? "#fef2f2" : "#f8fafc",
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  color: overdue ? "#b91c1c" : "var(--text-muted, #475569)",
                  marginBottom: 2,
                  fontWeight: overdue ? 600 : 400,
                }}
              >
                {overdue ? "Overdue · " : "Due "}
                {new Date(f.dueAt).toLocaleString()} · {f.createdByEmail}
              </div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                {f.body}
              </div>
            </div>
            <Button
              size="sm"
              intent="secondary"
              disabled={completingId === f.id}
              onClick={() => onComplete(f.id)}
              data-testid={`admin-customer-followups-complete-${f.id}`}
            >
              <CheckCircle2 size={12} />
              {completingId === f.id ? "Saving…" : "Done"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

// "Tomorrow at 9am, local time" — formatted for <input type="datetime-local">.
// Minutes / seconds zeroed so the timestamp is clean and predictable.
function defaultDueLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return formatLocal(d);
}

function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocal(s: string): Date | null {
  // <input type="datetime-local"> emits naive local timestamps;
  // `new Date(s)` treats them as local time, which is what we want
  // before serializing back to ISO via toISOString().
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
