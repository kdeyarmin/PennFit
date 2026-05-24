// Patient-detail action bar — the row of "Quick actions" buttons at
// the top of every patient page.
//
// Buttons cover three workflows:
//   1. Reach the patient now — SMS / email / voice call against the
//      currently-targeted episode.
//   2. Lifecycle — pause / resume / close / reopen the patient row.
//   3. Undo close — 8-second window after a close so a misclick is
//      one tap away from reversal.
//
// Every successful action calls onAfterAction so the parent page can
// refetch the patient (audit log, episodes, status all change).

import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  usePlaceVoiceCall,
  useSendEmailReminder,
  useSendSmsReminder,
  useUpdatePatient,
  type PatientDetail,
} from "@workspace/api-client-react/admin";

import { humanizeStatus } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

/**
 * Renders the "Quick actions" card for a patient page with controls for sending SMS/email/voice reminders,
 * changing lifecycle status (resume/pause/close/reopen), and an inline 8-second "Undo" for closes.
 *
 * The component displays buttons for sending reminders against a selected episode, a single lifecycle action
 * button appropriate to the patient's current status, an undo-close banner while the undo window is active,
 * and a feedback message area. After any successful server mutation, it invokes `onAfterAction`.
 *
 * @param patient - The patient detail object the actions operate on.
 * @param onAfterAction - Called after a successful action to allow the parent to refresh or refetch state.
 * @returns The rendered PatientActionBar React element.
 */
export function PatientActionBar({
  patient,
  onAfterAction,
}: {
  patient: PatientDetail;
  onAfterAction: () => void;
}) {
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const sms = useSendSmsReminder();
  const email = useSendEmailReminder();
  const voice = usePlaceVoiceCall();
  const update = useUpdatePatient();
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  // Undo-close UI state. When the admin successfully closes a
  // patient we surface an inline "Undo" affordance with an
  // 8-second countdown. Clicking Undo reopens (status → active).
  // Letting the timer expire dismisses the affordance silently —
  // the close itself already took effect server-side at the moment
  // the PATCH succeeded; "Undo" is purely a follow-up reverse PATCH.
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (closedAt === null) return;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - closedAt) / 1000);
      const remaining = Math.max(0, 8 - elapsed);
      setSecondsLeft(remaining);
      if (remaining === 0) setClosedAt(null);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [closedAt]);

  // Pick the "current" episode for send-now actions. We prefer
  // anything in active outreach (outreach_pending / awaiting_response)
  // over confirmed/declined so reminders go to the patient's
  // currently-pending order, not the historic one. Falls back to the
  // newest episode otherwise so the buttons aren't dead when the
  // engine hasn't scheduled anything.
  const targetEpisode = useMemo(() => {
    const eps = patient.episodes;
    if (eps.length === 0) return null;
    const live = eps.find(
      (e) =>
        e.status === "outreach_pending" || e.status === "awaiting_response",
    );
    if (live) return live;
    // newest by createdAt
    return [...eps].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [patient.episodes]);

  const isMutating =
    sms.isPending || email.isPending || voice.isPending || update.isPending;

  function describe(err: unknown): string {
    if (err instanceof ApiError) {
      const data = err.data as { error?: string; message?: string } | undefined;
      return data?.message ?? data?.error ?? "Request failed.";
    }
    return err instanceof Error ? err.message : "Request failed.";
  }

  function fire(label: string, p: Promise<unknown>) {
    setFeedback(null);
    p.then(() => {
      setFeedback({ kind: "success", text: `${label} sent.` });
      onAfterAction();
    }).catch((err: unknown) => {
      setFeedback({ kind: "error", text: `${label} failed: ${describe(err)}` });
    });
  }

  async function changeStatus(next: "active" | "paused" | "closed") {
    if (next === patient.status) return;
    if (next === "closed") {
      if (
        !(await confirm({
          title: "Close patient?",
          description:
            "Closed patients are removed from outreach permanently. Proceed?",
          confirmLabel: "Close patient",
          destructive: true,
        }))
      ) {
        return;
      }
    }
    setFeedback(null);
    try {
      await update.mutateAsync({
        id: patient.id,
        data: { status: next, expectedUpdatedAt: patient.updatedAt },
      });
      onAfterAction();
      if (next === "closed") {
        // Surface the undo affordance INSTEAD of the regular feedback
        // banner. The undo banner replaces the success line so we
        // don't double-stack messages on top of each other.
        setClosedAt(Date.now());
      } else {
        setClosedAt(null);
        setFeedback({
          kind: "success",
          text:
            next === "active"
              ? "Patient resumed. Outreach scan will pick them up again."
              : "Patient paused. Outreach scan will skip them.",
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFeedback({
          kind: "error",
          text: "Patient was changed elsewhere — refreshing. Please re-apply the status change.",
        });
        onAfterAction();
        return;
      }
      setFeedback({ kind: "error", text: describe(err) });
    }
  }

  async function undoClose() {
    setClosedAt(null);
    setFeedback(null);
    // Defense-in-depth: if another admin (or this admin from another
    // tab) mutated the patient's status during the 8-second undo
    // window, the client-side guard catches the obvious case
    // immediately. The server-side `expectedUpdatedAt` precondition
    // catches the race that survives this check.
    if (patient.status !== "closed") {
      setFeedback({
        kind: "error",
        text: "Patient was already updated elsewhere — undo skipped to avoid clobbering a newer change.",
      });
      return;
    }
    try {
      await update.mutateAsync({
        id: patient.id,
        data: { status: "active", expectedUpdatedAt: patient.updatedAt },
      });
      onAfterAction();
      setFeedback({
        kind: "success",
        text: "Close undone — patient is active again.",
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFeedback({
          kind: "error",
          text: "Patient was changed elsewhere during undo — refreshing.",
        });
        onAfterAction();
        return;
      }
      setFeedback({ kind: "error", text: `Undo failed: ${describe(err)}` });
    }
  }

  const noEpisode = !targetEpisode;
  const isActive = patient.status === "active";
  const sendDisabled = !isActive || noEpisode;
  const sendDisabledHint = !isActive
    ? `Patient is ${humanizeStatus(patient.status).toLowerCase()} — resume to send reminders.`
    : noEpisode
      ? "No episode available — create a prescription first."
      : null;

  return (
    <Card
      title="Quick actions"
      subtitle="Every action writes to the audit log."
    >
      <div className="space-y-3">
        <div>
          <p
            className="text-xs uppercase tracking-wider font-semibold mb-2"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Reach the patient now
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              isLoading={sms.isPending}
              disabled={
                sendDisabled ||
                (isMutating && !sms.isPending) ||
                !patient.hasPhone
              }
              onClick={() =>
                targetEpisode &&
                fire(
                  "SMS reminder",
                  sms.mutateAsync({
                    data: {
                      patientId: patient.id,
                      episodeId: targetEpisode.id,
                    },
                  }),
                )
              }
            >
              Send SMS reminder
            </Button>
            <Button
              intent="secondary"
              isLoading={email.isPending}
              disabled={
                sendDisabled ||
                (isMutating && !email.isPending) ||
                !patient.hasEmail
              }
              onClick={() =>
                targetEpisode &&
                fire(
                  "Email reminder",
                  email.mutateAsync({
                    data: {
                      patientId: patient.id,
                      episodeId: targetEpisode.id,
                    },
                  }),
                )
              }
            >
              Send email reminder
            </Button>
            <Button
              intent="secondary"
              isLoading={voice.isPending}
              disabled={
                sendDisabled ||
                (isMutating && !voice.isPending) ||
                !patient.hasPhone
              }
              onClick={() =>
                targetEpisode &&
                fire(
                  "Voice call",
                  voice.mutateAsync({
                    data: {
                      patientId: patient.id,
                      episodeId: targetEpisode.id,
                    },
                  }),
                )
              }
            >
              Place voice call
            </Button>
          </div>
          {sendDisabledHint && (
            <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {sendDisabledHint}
            </p>
          )}
          {!sendDisabled && !patient.hasPhone && (
            <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              No phone on file — SMS / voice disabled.
            </p>
          )}
          {!sendDisabled && !patient.hasEmail && (
            <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              No email on file — email disabled.
            </p>
          )}
        </div>

        <div>
          <p
            className="text-xs uppercase tracking-wider font-semibold mb-2"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Lifecycle
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {patient.status === "paused" && (
              <Button
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("active")}
              >
                Resume patient
              </Button>
            )}
            {patient.status === "active" && (
              <Button
                intent="secondary"
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("paused")}
              >
                Pause patient
              </Button>
            )}
            {patient.status !== "closed" && (
              <Button
                intent="secondary"
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("closed")}
              >
                Close patient
              </Button>
            )}
            {patient.status === "closed" && (
              <Button
                intent="secondary"
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("active")}
              >
                Reopen patient
              </Button>
            )}
          </div>
        </div>
      </div>

      {closedAt !== null && (
        <div
          className="mt-3 flex items-center justify-between gap-3 rounded border px-3 py-2"
          style={{ borderColor: "#c9a24a", backgroundColor: "#fff8e7" }}
          role="status"
        >
          <span className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
            Patient closed. Reopen?{" "}
            <span style={{ color: "hsl(var(--ink-3))" }}>({secondsLeft}s)</span>
          </span>
          <Button
            intent="secondary"
            isLoading={update.isPending}
            disabled={update.isPending}
            onClick={() => void undoClose()}
          >
            Undo
          </Button>
        </div>
      )}
      {feedback && (
        <p
          className="mt-3 text-sm"
          style={{ color: feedback.kind === "success" ? "#166534" : "#991b1b" }}
          role="status"
        >
          {feedback.text}
        </p>
      )}
      {ConfirmDialogEl}
    </Card>
  );
}
