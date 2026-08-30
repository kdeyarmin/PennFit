// /admin/fitter-followups — who went quiet after a mask fitting.
//
// The fitter funnel had two silent drop-offs and nothing watched either
// of them (migration 0536). This is the page that watches:
//
//   * a link you sent that was never opened, or opened and abandoned
//     partway through — while the link is still live and can be
//     recovered;
//   * a fitting somebody FINISHED that never turned into a request. The
//     expensive one: the measurements, the questionnaire and a
//     defensible recommendation already exist, and the patient is one
//     phone call from having their mask;
//   * a request they DID send that nobody here has worked past the one
//     business day the results page promises them. That one is ours,
//     not theirs, and it sits in the same list on purpose — from the
//     patient's side "I asked and nobody called" and "I did the fitting
//     and nothing happened" are the same experience.
//
// The hourly sweep also sends the patient-facing follow-ups (gated per
// tenant by `fitter.followup_nudges`) and CLOSES a row on its own the
// moment the patient acts, so an open row here always means somebody is
// still waiting.
//
// Deliberately no "send another nudge" button. The sweep owns the
// cadence, and its per-invite stamps are the only thing stopping a
// patient being messaged twice; a button here would bypass both. What
// staff need is the phone number, and that is the first column.
//
// Hand-rolled Tailwind to match the queue it sits beside
// (admin-fitter-requests.tsx) — no shadcn dependency.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { useDocumentTitle } from "@/hooks/admin/use-document-title";
import {
  type FitterFollowupAlertRow,
  type FitterFollowupAlertStatus,
  type FitterFollowupAlertType,
  type FitterFollowupResolvedReason,
  type FitterFollowupSeverity,
  listFitterFollowupAlerts,
  updateFitterFollowupAlert,
  type UpdateFitterFollowupAlertInput,
} from "@/lib/admin/fitter-followup-alerts-api";
import { formatAppDate } from "@/lib/utils";

/**
 * Copy, not labels. Each entry says what actually happened and what the
 * person reading it should do next — a CSR should not have to learn four
 * enum names to work this queue.
 */
const TYPE_META: Record<
  FitterFollowupAlertType,
  { label: string; blurb: string; action: string; bg: string; fg: string }
> = {
  fit_no_request: {
    label: "Fitting done, no request",
    blurb: "They finished the fitting and never asked us to order.",
    action: "Call them — the fitting is done, this is a benefits check away.",
    bg: "#fee2e2",
    fg: "#7f1d1d",
  },
  fit_abandoned: {
    label: "Started, didn't finish",
    blurb: "They opened the link and stopped partway through.",
    action: "Something stopped them. Worth a call to find out what.",
    bg: "#ffedd5",
    fg: "#7c2d12",
  },
  fit_not_started: {
    label: "Link never opened",
    blurb: "The link was delivered and never opened.",
    action: "Check the address is right, or reach them another way.",
    bg: "#fef3c7",
    fg: "#854d0e",
  },
  request_unworked: {
    label: "Request not worked",
    blurb: "They asked us to take it from here and nobody has yet.",
    action: "This one is ours. Open Fit requests and work the row.",
    bg: "#e0e7ff",
    fg: "#3730a3",
  },
};

/** Order matters: worst outcome first, so the tiles read as a funnel. */
const TYPE_ORDER: readonly FitterFollowupAlertType[] = [
  "fit_no_request",
  "fit_abandoned",
  "fit_not_started",
  "request_unworked",
];

/**
 * How this person was reached about the fitting. `in_office` is a real
 * value, not a fallback: a QR handed over at the counter picks no
 * channel, and a completed one still reaches this queue.
 */
const CONTACT_METHOD_LABEL: Record<string, string> = {
  phone: "Asked for a call",
  email: "Contacted by email",
  text: "Contacted by text",
  in_office: "Fitted in the office — no channel chosen",
};

const SEVERITY_STYLE: Record<
  FitterFollowupSeverity,
  { bg: string; fg: string; label: string }
> = {
  high: { bg: "#fee2e2", fg: "#7f1d1d", label: "High" },
  medium: { bg: "#fef3c7", fg: "#854d0e", label: "Medium" },
  low: { bg: "#f1f5f9", fg: "#475569", label: "Low" },
};

/**
 * Why the sweep closed a row on its own. Worth spelling out: a CSR
 * looking at the resolved list is asking "did the follow-up work?", and
 * "the patient asked us to order" is a different answer from "staff
 * revoked the invite".
 */
const RESOLVED_LABEL: Record<FitterFollowupResolvedReason, string> = {
  fit_completed: "They finished the fitting",
  request_received: "They asked us to order",
  dispensed: "Mask dispensed",
  invite_revoked: "Invite revoked by staff",
  request_worked: "A CSR picked the request up",
};

const STATUS_TABS: ReadonlyArray<{
  value: FitterFollowupAlertStatus | "all";
  label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

function formatWaiting(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 60) return `${days}d`;
  return formatAppDate(iso);
}

/** Whole days between an ISO timestamp and now, or null. */
function daysSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

/**
 * Whole days from now until an ISO timestamp — SIGNED, so a link that
 * has already died reads as negative rather than as "expires today".
 *
 * A cohort-A alert stays open until the patient acts, which includes
 * long after the invite itself expires. Clamping at zero told staff
 * "their link expires today" forever, which is worse than saying
 * nothing: it points them at a dead link instead of a resend.
 */
function daysUntil(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - nowMs) / 86_400_000);
}

export function AdminFitterFollowupsPage() {
  useDocumentTitle("Admin · Fitter follow-ups");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState<FitterFollowupAlertStatus | "all">(
    "open",
  );
  const [type, setType] = useState<FitterFollowupAlertType | "all">("all");
  const [pendingId, setPendingId] = useState<string | null>(null);

  const queryKey = ["admin", "fitter-followups", status, type] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listFitterFollowupAlerts(status, type),
  });

  const updateMut = useMutation({
    mutationFn: (args: { id: string; patch: UpdateFitterFollowupAlertInput }) =>
      updateFitterFollowupAlert(args.id, args.patch),
    onMutate: (args) => setPendingId(args.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["admin", "fitter-followups"],
      });
    },
    onError: (err) => {
      toast({
        title: "Couldn't update that alert",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
    onSettled: () => setPendingId(null),
  });

  const alerts = data?.alerts ?? [];
  const counts = useMemo(
    () =>
      data?.counts ?? {
        fit_not_started: 0,
        fit_abandoned: 0,
        fit_no_request: 0,
        request_unworked: 0,
      },
    [data],
  );
  const nowMs = Date.now();

  return (
    <div className="space-y-6" data-testid="admin-fitter-followups-page">
      <PageHeader
        title="Fitter follow-ups"
        descriptionClassName="max-w-2xl"
        description={
          <>
            Everyone whose mask fitting went quiet — a link nobody opened, a
            fitting nobody finished, a finished fitting that never turned into a
            request, and requests we haven&rsquo;t worked yet. Automatic
            reminders go out on their own; a row stays here until the patient
            actually acts, so an open row means somebody is still waiting.
            <span className="mt-1 block font-semibold">
              Highest severity first, then longest waiting.
            </span>
          </>
        }
      />

      <div
        className="grid grid-cols-2 lg:grid-cols-4 gap-3"
        data-testid="fitter-followups-counts"
      >
        {TYPE_ORDER.map((t) => {
          const meta = TYPE_META[t];
          const selected = type === t;
          return (
            <button
              type="button"
              key={t}
              onClick={() => setType(selected ? "all" : t)}
              aria-pressed={selected}
              className="text-left border rounded-lg p-3 bg-white hover:shadow transition-shadow"
              style={{
                borderColor: selected ? meta.fg : "hsl(var(--line-1))",
                outline: selected ? `2px solid ${meta.fg}` : "none",
                outlineOffset: "-2px",
              }}
              data-testid={`fitter-followups-count-${t}`}
            >
              <div
                className="text-[10px] font-bold uppercase tracking-wider mb-1"
                style={{ color: meta.fg }}
              >
                {meta.label}
              </div>
              <div
                className="text-2xl font-semibold tabular-nums"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {counts[t]}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 leading-snug">
                {meta.blurb}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => (
          <button
            type="button"
            key={tab.value}
            onClick={() => setStatus(tab.value)}
            aria-pressed={status === tab.value}
            className="px-3 py-1.5 rounded text-xs font-semibold border bg-white"
            style={{
              color: status === tab.value ? "#fff" : "hsl(var(--ink-1))",
              backgroundColor:
                status === tab.value ? "hsl(var(--ink-1))" : "#fff",
              borderColor: "hsl(var(--line-1))",
            }}
            data-testid={`fitter-followups-status-${tab.value}`}
          >
            {tab.label}
          </button>
        ))}
        {type !== "all" && (
          <button
            type="button"
            onClick={() => setType("all")}
            className="px-3 py-1.5 rounded text-xs font-semibold border bg-white"
            style={{
              color: "hsl(var(--ink-1))",
              borderColor: "hsl(var(--line-1))",
            }}
            data-testid="fitter-followups-clear-type"
          >
            Clear type filter
          </button>
        )}
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold border bg-white disabled:opacity-50"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="fitter-followups-refresh"
        >
          Refresh
        </button>
        <span className="text-xs text-slate-500">
          Showing {alerts.length} · {data?.openTotal ?? 0} open
          {(data?.openHigh ?? 0) > 0 ? `, ${data?.openHigh} high` : ""}
        </span>
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div
        className="border rounded-lg bg-white overflow-x-auto"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <table className="w-full text-sm min-w-[900px]">
          <thead style={{ backgroundColor: "#f8fafc" }}>
            <tr style={{ color: "#475569" }}>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Who to reach
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                What happened
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Automatic follow-up
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Waiting
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Note
              </th>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!isPending && !isError && alerts.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  {status === "open"
                    ? "Nobody is waiting — every fitting has been followed up."
                    : "Nothing here."}
                </td>
              </tr>
            )}
            {alerts.map((row) => (
              <AlertRow
                key={row.id}
                row={row}
                nowMs={nowMs}
                pending={pendingId === row.id}
                onPatch={(patch) => updateMut.mutate({ id: row.id, patch })}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AlertRow({
  row,
  nowMs,
  pending,
  onPatch,
}: {
  row: FitterFollowupAlertRow;
  nowMs: number;
  pending: boolean;
  onPatch: (patch: UpdateFitterFollowupAlertInput) => void;
}) {
  const [noteDraft, setNoteDraft] = useState(row.staffNote ?? "");
  // Re-sync the draft when the SERVER's value changes underneath us.
  //
  // The row is keyed by id, so React keeps this component mounted across
  // refetches and `useState`'s initial value is read exactly once. In a
  // queue several CSRs work at the same time, that means a note another
  // person saved would never appear here — and worse, blurring this
  // field would then push the value captured at mount back over theirs,
  // silently reverting their edit.
  //
  // Render-phase adjustment rather than an effect: it runs before paint,
  // so the textarea never flashes the stale value. Guarded on the server
  // value actually CHANGING, so an ordinary refetch (window focus, a
  // status-only PATCH) leaves in-progress typing alone.
  const serverNote = row.staffNote ?? "";
  const [lastServerNote, setLastServerNote] = useState(serverNote);
  if (serverNote !== lastServerNote) {
    setLastServerNote(serverNote);
    setNoteDraft(serverNote);
  }
  const meta = TYPE_META[row.alertType];
  const sev = SEVERITY_STYLE[row.severity];
  const contact = row.contact;
  // Computed from the underlying timestamps, NOT from `detail`.
  //
  // An alert row is inserted once and never re-raised, so every number
  // the sweep stamped into `detail` is frozen at raise time — rendering
  // those would tell a CSR a request has been waiting two days when it
  // has been waiting three weeks, which is the one thing this queue
  // exists to make visible.
  const daysWaiting =
    daysSince(row.fittingCompletedAt, nowMs) ??
    daysSince(row.requestCreatedAt, nowMs) ??
    daysSince(row.linkSentAt, nowMs);
  const linkDaysLeft =
    row.status === "open" ? daysUntil(row.inviteExpiresAt, nowMs) : null;

  return (
    <tr
      className="border-t align-top"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`fitter-followup-row-${row.id}`}
    >
      <td className="px-3 py-3">
        <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
          {contact?.name?.trim() || "Name not on file"}
        </div>
        {contact?.phone ? (
          <div className="text-xs mt-0.5">
            <a className="hover:underline" href={`tel:${contact.phone}`}>
              {contact.phone}
            </a>
          </div>
        ) : null}
        {contact?.email ? (
          <div className="text-xs text-slate-500 break-all">
            <a className="hover:underline" href={`mailto:${contact.email}`}>
              {contact.email}
            </a>
          </div>
        ) : null}
        {!contact?.phone && !contact?.email && (
          <div className="text-xs text-slate-400 italic mt-0.5">
            No contact on the record
          </div>
        )}
        {contact && (
          <div className="text-xs text-slate-500 mt-1">
            {CONTACT_METHOD_LABEL[contact.preferredMethod] ??
              contact.preferredMethod}
            {contact.preferredTime ? ` · ${contact.preferredTime}` : ""}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-2 text-[11px]">
          {row.patientId ? (
            <Link
              href={`/admin/patients/${row.patientId}`}
              className="text-sky-700 hover:underline"
            >
              Open chart
            </Link>
          ) : (
            <span className="text-slate-400">Not a patient yet</span>
          )}
          {row.fitRequestId && (
            <Link
              href="/admin/fitter-requests"
              className="text-sky-700 hover:underline"
            >
              Fit requests
            </Link>
          )}
          {row.fitterInviteId && (
            <Link
              href="/admin/fitter-invites"
              className="text-sky-700 hover:underline"
            >
              Fitter invites
            </Link>
          )}
          {row.fitSessionId && (
            <Link
              href="/admin/fit-sessions"
              className="text-sky-700 hover:underline"
            >
              Fitting record
            </Link>
          )}
        </div>
      </td>

      <td className="px-3 py-3 text-xs text-slate-600">
        <span
          className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{ backgroundColor: meta.bg, color: meta.fg }}
        >
          {meta.label}
        </span>
        <span
          className="inline-block ml-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{ backgroundColor: sev.bg, color: sev.fg }}
          title="How urgent this is"
        >
          {sev.label}
        </span>
        <div className="mt-1.5 text-slate-700">{meta.blurb}</div>
        {row.status === "open" && (
          <div className="mt-1 italic text-slate-500">{meta.action}</div>
        )}
        {row.recommendedMaskName && (
          <div className="mt-1 font-semibold text-slate-800">
            {row.recommendedMaskName}
          </div>
        )}
        {typeof linkDaysLeft === "number" &&
          row.alertType !== "fit_no_request" &&
          row.alertType !== "request_unworked" && (
            <div
              className="mt-1"
              style={{ color: linkDaysLeft < 0 ? "#b91c1c" : "#64748b" }}
            >
              {linkDaysLeft > 0
                ? `Their link works for ${linkDaysLeft} more day(s)`
                : linkDaysLeft === 0
                  ? "Their link expires today"
                  : "Their link has expired — send them a new one"}
            </div>
          )}
        {row.status === "resolved" && row.resolvedReason && (
          <div className="mt-1 font-semibold" style={{ color: "#166534" }}>
            {RESOLVED_LABEL[row.resolvedReason]}
          </div>
        )}
        {row.status === "dismissed" && (
          <div className="mt-1 text-slate-500">
            Dismissed{row.dismissedByEmail ? ` by ${row.dismissedByEmail}` : ""}
          </div>
        )}
      </td>

      <td className="px-3 py-3 text-xs text-slate-600">
        {row.nudgeCount > 0 ? (
          <>
            <div className="font-semibold text-slate-800">
              {row.nudgeCount === 1
                ? "1 reminder sent"
                : `${row.nudgeCount} reminders sent`}
            </div>
            {row.lastNudgeAt && (
              <div className="text-slate-500">
                Last {formatAppDate(row.lastNudgeAt)}
                {row.lastNudgeChannel ? ` by ${row.lastNudgeChannel}` : ""}
              </div>
            )}
          </>
        ) : (
          <span className="text-slate-400 italic">
            {row.alertType === "request_unworked"
              ? "Not applicable — this one is ours"
              : "None sent yet"}
          </span>
        )}
      </td>

      <td className="px-3 py-3 text-xs">
        <div className="font-semibold text-slate-800 tabular-nums">
          {formatWaiting(row.createdAt, nowMs)}
        </div>
        {typeof daysWaiting === "number" && (
          <div className="text-slate-500">
            {daysWaiting} day(s) since{" "}
            {row.alertType === "fit_no_request"
              ? "the fitting"
              : row.alertType === "request_unworked"
                ? "they asked"
                : "the link went out"}
          </div>
        )}
      </td>

      <td className="px-3 py-3">
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => {
            if (noteDraft === (row.staffNote ?? "")) return;
            onPatch({ staffNote: noteDraft });
          }}
          rows={2}
          maxLength={2000}
          disabled={pending}
          placeholder="What you did / what's next"
          aria-label="Staff note"
          className="w-full min-w-[160px] text-xs border rounded px-2 py-1 disabled:opacity-50"
          style={{ borderColor: "hsl(var(--line-1))" }}
          data-testid={`fitter-followup-note-${row.id}`}
        />
        <div className="mt-1.5">
          {row.status === "open" ? (
            <button
              type="button"
              onClick={() => onPatch({ status: "dismissed" })}
              disabled={pending}
              className="px-2 py-1 rounded text-[11px] font-semibold border bg-white disabled:opacity-50"
              style={{
                color: "hsl(var(--ink-1))",
                borderColor: "hsl(var(--line-1))",
              }}
              title="Nothing more to do here. It will not come back."
              data-testid={`fitter-followup-dismiss-${row.id}`}
            >
              Dismiss
            </button>
          ) : row.status === "dismissed" ? (
            <button
              type="button"
              onClick={() => onPatch({ status: "open" })}
              disabled={pending}
              className="px-2 py-1 rounded text-[11px] font-semibold border bg-white disabled:opacity-50"
              style={{
                color: "hsl(var(--ink-1))",
                borderColor: "hsl(var(--line-1))",
              }}
              data-testid={`fitter-followup-reopen-${row.id}`}
            >
              Reopen
            </button>
          ) : (
            <span className="text-[11px] text-slate-400 italic">
              Closed automatically
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}
