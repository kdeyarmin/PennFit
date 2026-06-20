// Patient-detail "Follow-ups" tab (Phase 19) — extracted from
// patient-detail.tsx.
//
// Patient-side parity with the shop_customer_followups panel
// (Phase 17). Composer + open queue ascending by due_at; overdue
// rows render in rose for instant visual triage. Completed
// followups don't show — they live in the audit log.
//
// Helpers FollowupsList + defaultFollowupDueLocal +
// parseFollowupDueLocal are scoped to this file.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { Button } from "@/components/admin/Button";
import { Label } from "@/components/admin/Input";
import { formatDateTime } from "@/lib/admin/format";
import {
  appDateTimeLocalInputValue,
  parseAppDateTimeLocalInput,
} from "@/lib/utils";
import {
  AdminPatientFollowupsNotFoundError,
  completeAdminPatientFollowup,
  createAdminPatientFollowup,
  listAdminPatientFollowups,
  type AdminPatientFollowup,
  type AdminPatientFollowupsListResponse,
} from "@/lib/admin/patient-followups-api";

const FOLLOWUP_MAX_BODY = 2000;

export function FollowupsTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [dueLocal, setDueLocal] = useState(defaultFollowupDueLocal());
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryKey = ["admin", "patients", patientId, "followups"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => listAdminPatientFollowups(patientId),
  });

  const createMutation = useMutation({
    mutationFn: ({ body, dueAt }: { body: string; dueAt: Date }) =>
      createAdminPatientFollowup(patientId, body, dueAt),
    onSuccess: () => {
      setBody("");
      setDueLocal(defaultFollowupDueLocal());
      setSubmitError(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to schedule followup.",
      );
    },
  });

  const completeMutation = useMutation({
    mutationFn: (followupId: string) =>
      completeAdminPatientFollowup(patientId, followupId),
    // Optimistic removal: the open queue only shows incomplete rows,
    // so completing one should drop it instantly instead of leaving
    // it (with a busy spinner) until the round-trip + refetch land.
    // Rolled back on error; settled always re-syncs with the server.
    onMutate: async (followupId) => {
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<AdminPatientFollowupsListResponse>(queryKey);
      if (previous) {
        queryClient.setQueryData<AdminPatientFollowupsListResponse>(queryKey, {
          ...previous,
          followups: previous.followups.filter((f) => f.id !== followupId),
        });
      }
      return { previous };
    },
    onError: (_err, _followupId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const trimmed = body.trim();
  const tooLong = trimmed.length > FOLLOWUP_MAX_BODY;
  const dueAtParsed = parseFollowupDueLocal(dueLocal);
  const validDate = dueAtParsed !== null && !isNaN(dueAtParsed.getTime());
  const canSubmit =
    trimmed.length > 0 && !tooLong && validDate && !createMutation.isPending;

  const completingId = completeMutation.isPending
    ? ((completeMutation.variables as string | undefined) ?? null)
    : null;

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit || dueAtParsed === null) return;
          createMutation.mutate({ body: trimmed, dueAt: dueAtParsed });
        }}
        className="space-y-2"
        data-testid="patient-followups-form"
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What do you need to do (e.g. 'Call about Rx renewal')?"
          aria-label="Follow-up task"
          rows={2}
          maxLength={FOLLOWUP_MAX_BODY + 200}
          disabled={createMutation.isPending}
          className="w-full rounded border px-3 py-2 text-sm font-sans"
          style={{ borderColor: "hsl(var(--line-1))" }}
          data-testid="patient-followups-body"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="patient-followup-due">Due</Label>
          <input
            id="patient-followup-due"
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            disabled={createMutation.isPending}
            className="rounded border px-2 py-1 text-xs"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid="patient-followups-due"
          />
          <span
            className="ml-auto text-xs"
            style={{ color: tooLong ? "#b91c1c" : "hsl(var(--ink-3))" }}
          >
            {trimmed.length} / {FOLLOWUP_MAX_BODY}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            isLoading={createMutation.isPending}
            data-testid="patient-followups-submit"
          >
            Schedule
          </Button>
        </div>
        {submitError && (
          <p className="text-xs" style={{ color: "#b91c1c" }} role="alert">
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
        completingId={completingId}
      />
    </div>
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
  followups: AdminPatientFollowup[];
  onComplete: (id: string) => void;
  completingId: string | null;
}) {
  if (isPending) {
    return <Spinner label="Loading followups…" />;
  }
  if (isError) {
    if (error instanceof AdminPatientFollowupsNotFoundError) {
      return (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Patient not found.
        </p>
      );
    }
    return (
      <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
        Failed to load followups.
      </p>
    );
  }
  if (followups.length === 0) {
    return (
      <EmptyState
        title="No open follow-ups."
        hint="Schedule one above to commit to a callback."
      />
    );
  }
  const now = Date.now();
  return (
    <ul className="space-y-2" data-testid="patient-followups-list">
      {followups.map((f) => {
        const due = new Date(f.dueAt).getTime();
        const overdue = due < now;
        return (
          <li
            key={f.id}
            className="rounded border p-3 flex gap-3 items-start"
            style={{
              borderColor: overdue ? "#fecaca" : "hsl(var(--line-1))",
              backgroundColor: overdue ? "#fef2f2" : "#ffffff",
            }}
          >
            <div className="flex-1 min-w-0">
              <div
                className="text-xs mb-1"
                style={{
                  color: overdue ? "#b91c1c" : "hsl(var(--ink-3))",
                  fontWeight: overdue ? 600 : 400,
                }}
              >
                {overdue ? "Overdue · " : "Due "}
                {formatDateTime(f.dueAt)} · {f.createdByEmail}
              </div>
              <div
                className="text-sm whitespace-pre-wrap break-words"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {f.body}
              </div>
            </div>
            <Button
              size="sm"
              intent="secondary"
              disabled={completingId !== null}
              onClick={() => onComplete(f.id)}
              data-testid={`patient-followups-complete-${f.id}`}
            >
              {completingId === f.id ? "Saving…" : "Done"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function defaultFollowupDueLocal(): string {
  return appDateTimeLocalInputValue({
    daysFromToday: 1,
    hour: 9,
    minute: 0,
  });
}

function parseFollowupDueLocal(s: string): Date | null {
  if (!s) return null;
  return parseAppDateTimeLocalInput(s);
}
