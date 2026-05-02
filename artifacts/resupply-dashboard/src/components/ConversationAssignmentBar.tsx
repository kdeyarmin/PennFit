// Inline assignment / priority / escalation control bar mounted at
// the top of the conversation detail page.
//
// Layout: a single row that surfaces the current state (assigned to /
// priority pill / SLA countdown / escalation badge if any) with
// inline action buttons next to each.
//
// Mutations use the hand-rolled wrappers in
// lib/conversation-assignment-api.ts; success triggers an
// onChange callback so the parent can refetch the conversation
// header.

import { useEffect, useState } from "react";
import { useDashboardIdentity } from "../lib/identity";
import {
  type Priority,
  claimConversation,
  deEscalateConversation,
  escalateConversation,
  releaseConversation,
  setConversationPriority,
} from "../lib/conversation-assignment-api";

const PRIORITY_TONE: Record<Priority, string> = {
  urgent: "bg-rose-100 text-rose-900 border-rose-300",
  high: "bg-amber-100 text-amber-900 border-amber-300",
  normal: "bg-slate-100 text-slate-700 border-slate-300",
  low: "bg-slate-50 text-slate-500 border-slate-200",
};

const PRIORITY_VALUES: Priority[] = ["low", "normal", "high", "urgent"];

export function ConversationAssignmentBar({
  conversationId,
  assignedAdminUserId,
  priority,
  slaDueAt,
  escalatedAt,
  escalationReason,
  status,
  onChange,
}: {
  conversationId: string;
  assignedAdminUserId: string | null;
  priority: Priority;
  slaDueAt: string | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  status: string;
  onChange: () => void;
}) {
  const { userId } = useDashboardIdentity();
  const callerId = userId;
  const isMine = !!assignedAdminUserId && assignedAdminUserId === callerId;
  const isUnassigned = !assignedAdminUserId;

  const [busy, setBusy] = useState<
    | "claim"
    | "release"
    | "priority"
    | "escalate"
    | "deescalate"
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showPriority, setShowPriority] = useState(false);
  const [showEscalate, setShowEscalate] = useState(false);
  const [escalateReason, setEscalateReason] = useState("");

  // Auto-clear error after 6s so the bar doesn't hold a stale red.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  async function run(
    op: "claim" | "release" | "priority" | "escalate" | "deescalate",
    fn: () => Promise<unknown>,
  ) {
    setBusy(op);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2"
      data-testid="conv-assignment-bar"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
            Assigned to
          </span>
          {isUnassigned ? (
            <span className="text-xs italic text-slate-500">Unassigned</span>
          ) : (
            <span
              className="text-xs font-mono text-slate-700"
              title={assignedAdminUserId ?? ""}
            >
              {isMine ? "You" : `${assignedAdminUserId?.slice(-8)}`}
            </span>
          )}
          {isUnassigned ? (
            <button
              type="button"
              onClick={() => void run("claim", () => claimConversation(conversationId))}
              disabled={busy !== null}
              className="text-xs font-semibold text-blue-700 hover:underline disabled:opacity-60"
              data-testid="conv-claim"
            >
              {busy === "claim" ? "Claiming…" : "Claim"}
            </button>
          ) : isMine ? (
            <button
              type="button"
              onClick={() => void run("release", () => releaseConversation(conversationId))}
              disabled={busy !== null}
              className="text-xs font-semibold text-slate-600 hover:underline disabled:opacity-60"
              data-testid="conv-release"
            >
              {busy === "release" ? "Releasing…" : "Release"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                void run("claim", () => claimConversation(conversationId, true))
              }
              disabled={busy !== null}
              className="text-xs font-semibold text-amber-700 hover:underline disabled:opacity-60"
              data-testid="conv-take-over"
            >
              {busy === "claim" ? "Taking over…" : "Take over"}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
            Priority
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${PRIORITY_TONE[priority]}`}
          >
            {priority}
          </span>
          <button
            type="button"
            onClick={() => setShowPriority((v) => !v)}
            className="text-xs font-semibold text-slate-600 hover:underline"
            data-testid="conv-priority-toggle"
          >
            Change
          </button>
        </div>

        <SlaIndicator slaDueAt={slaDueAt} status={status} />

        <div className="flex items-center gap-2 ml-auto">
          {escalatedAt ? (
            <>
              <span className="inline-flex items-center rounded-full border border-rose-300 bg-rose-100 text-rose-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                Escalated
              </span>
              <button
                type="button"
                onClick={() =>
                  void run("deescalate", () => deEscalateConversation(conversationId))
                }
                disabled={busy !== null}
                className="text-xs font-semibold text-slate-600 hover:underline disabled:opacity-60"
                data-testid="conv-deescalate"
              >
                {busy === "deescalate" ? "Clearing…" : "Clear escalation"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowEscalate((v) => !v)}
              className="text-xs font-semibold text-rose-700 hover:underline"
              data-testid="conv-escalate-toggle"
            >
              Escalate
            </button>
          )}
        </div>
      </div>

      {showPriority && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] text-slate-500">Set priority to:</span>
          {PRIORITY_VALUES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() =>
                void run("priority", async () => {
                  await setConversationPriority(conversationId, p);
                  setShowPriority(false);
                })
              }
              disabled={busy !== null || p === priority}
              className={`text-[11px] font-semibold uppercase tracking-wider rounded-full border px-2 py-0.5 ${PRIORITY_TONE[p]} disabled:opacity-50`}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {showEscalate && !escalatedAt && (
        <div className="flex flex-wrap gap-2 pt-1 items-start">
          <input
            type="text"
            value={escalateReason}
            onChange={(e) => setEscalateReason(e.target.value.slice(0, 500))}
            placeholder="Reason (required)"
            className="flex-1 min-w-[16rem] rounded border border-slate-300 px-2 py-1.5 text-xs"
            data-testid="conv-escalate-reason"
          />
          <button
            type="button"
            onClick={() =>
              void run("escalate", async () => {
                if (!escalateReason.trim()) {
                  throw new Error("Escalation reason is required.");
                }
                await escalateConversation(conversationId, {
                  reason: escalateReason.trim(),
                });
                setEscalateReason("");
                setShowEscalate(false);
              })
            }
            disabled={busy !== null || !escalateReason.trim()}
            className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
            data-testid="conv-escalate-submit"
          >
            {busy === "escalate" ? "Escalating…" : "Escalate"}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowEscalate(false);
              setEscalateReason("");
            }}
            className="text-xs text-slate-600 hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {escalationReason && escalatedAt && (
        <p className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
          <span className="font-semibold">Escalation note: </span>
          {escalationReason}
        </p>
      )}

      {error && (
        <p className="text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SlaIndicator({
  slaDueAt,
  status,
}: {
  slaDueAt: string | null;
  status: string;
}) {
  if (!slaDueAt || (status !== "open" && status !== "awaiting_admin")) {
    return null;
  }
  const due = new Date(slaDueAt);
  const minsLeft = Math.round((due.getTime() - Date.now()) / 60000);
  const breached = minsLeft <= 0;
  const soon = !breached && minsLeft <= 30;
  const label = breached
    ? `${Math.abs(minsLeft)}m past SLA`
    : minsLeft < 60
      ? `${minsLeft}m left in SLA`
      : `${Math.round(minsLeft / 60)}h left in SLA`;
  return (
    <span
      className={`text-xs font-semibold tabular-nums ${
        breached
          ? "text-rose-700"
          : soon
            ? "text-amber-700"
            : "text-emerald-700"
      }`}
      title={`SLA due ${due.toLocaleString()}`}
    >
      ⏱ {label}
    </span>
  );
}
