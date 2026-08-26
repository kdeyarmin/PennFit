// /admin/fitter-requests — the worklist a mask fitting now ends in.
//
// Under `fitter.lead_capture_only` the patient no longer files their own
// insurance order. They finish the fitter, see their recommendation, and
// either send their details or ask to be called. Those requests land
// here and a person places the order.
//
// The page is deliberately a QUEUE, not a report: oldest first (the
// patient was told "within one business day"), a status per row, and a
// note field. PHI is shown in the clear because the requireAdmin gate
// has already cleared the PHI-access policy check.
//
// Sits beside — not inside — two neighbouring surfaces:
//   * Fitter Prospects (/admin/fitter-leads) is the MARKETING funnel:
//     opt-ins and nurture touches, no request behind them.
//   * Insurance Leads (/admin/shop/insurance-leads) is a benefit check
//     with no fitting behind it.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type FitRequestRow,
  type FitRequestStatus,
  type FitRequestType,
  listFitRequests,
  updateFitRequest,
  type FitRequestClosedOutcome,
  type UpdateFitRequestInput,
} from "@/lib/admin/fitter-requests-api";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { formatAppDate } from "@/lib/utils";

const STATUS_STYLE: Record<
  FitRequestStatus,
  { bg: string; fg: string; label: string }
> = {
  new: { bg: "#fee2e2", fg: "#7f1d1d", label: "New" },
  contacted: { bg: "#fef3c7", fg: "#854d0e", label: "Contacted" },
  in_progress: { bg: "#dbeafe", fg: "#1e3a8a", label: "In progress" },
  closed: { bg: "#f1f5f9", fg: "#475569", label: "Closed" },
};

// The close outcomes, in the order a CSR is most likely to need them.
// `fulfilled` leads because it is both the commonest and the only one
// that records anything beyond this queue: it stamps the linked fitting
// as dispensed, which is what the fitter outcomes dashboard counts.
const CLOSED_OUTCOME_LABEL: Record<FitRequestClosedOutcome, string> = {
  fulfilled: "Fulfilled — patient has their mask",
  not_proceeding: "Not proceeding",
  unreachable: "Couldn't reach them",
  duplicate: "Duplicate",
};
const CLOSED_OUTCOME_ORDER: readonly FitRequestClosedOutcome[] = [
  "fulfilled",
  "not_proceeding",
  "unreachable",
  "duplicate",
];

const STATUS_ORDER: readonly FitRequestStatus[] = [
  "new",
  "contacted",
  "in_progress",
  "closed",
];

const CONTACT_METHOD_LABEL: Record<
  FitRequestRow["preferredContactMethod"],
  string
> = {
  phone: "Call",
  email: "Email",
  text: "Text",
};

function formatWaiting(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return formatAppDate(iso);
}

export function AdminFitterRequestsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FitRequestStatus | "all">("new");
  const [typeFilter, setTypeFilter] = useState<FitRequestType | "all">("all");
  const queryKey = ["admin", "fitter-requests", filter, typeFilter] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listFitRequests(filter, typeFilter),
  });

  // Only the row being mutated is disabled, rather than graying the
  // whole table while one PATCH is in flight.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { toast } = useToast();

  const updateMut = useMutation({
    mutationFn: (args: { id: string; patch: UpdateFitRequestInput }) =>
      updateFitRequest(args.id, args.patch),
    onMutate: (args) => setPendingId(args.id),
    onSuccess: (res, vars) => {
      if (
        vars.patch.status === "closed" &&
        vars.patch.closedOutcome === "fulfilled" &&
        res.dispenseStamped === false
      ) {
        toast({
          title: "Closed, but dispense was not recorded",
          description:
            "The request is closed as fulfilled, but the linked fitting could not be stamped as dispensed. Try closing again, or check that a fit session is linked.",
          variant: "destructive",
        });
      } else if (res.dispenseStamped) {
        toast({
          title: "Marked fulfilled",
          description: "The fitting was stamped as dispensed.",
        });
      } else if (res.dispenseCleared) {
        toast({
          title: "Dispense stamp withdrawn",
          description:
            "An earlier fulfilled stamp was cleared to match this outcome.",
        });
      }
    },
    onSettled: () => {
      setPendingId(null);
      // The common mutation ("new" → "contacted") moves a row across
      // the active filter, so refresh the list AND the counts strip.
      void queryClient.invalidateQueries({
        queryKey: ["admin", "fitter-requests"],
      });
    },
  });

  const rows = data?.rows ?? [];
  const counts = useMemo(
    () => data?.counts ?? { new: 0, contacted: 0, in_progress: 0, closed: 0 },
    [data?.counts],
  );
  const total = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );
  const nowMs = Date.now();

  return (
    <div className="space-y-6" data-testid="admin-fitter-requests-page">
      <PageHeader
        title="Fit requests"
        descriptionClassName="max-w-2xl"
        description={
          <>
            Patients who finished the mask fitter and asked you to take it from
            there — either by sending their details or by asking for a call.
            Nothing here has been ordered or billed. Oldest first, because the
            confirmation email promises a reply within one business day.
          </>
        }
      />

      <div
        className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        data-testid="fit-requests-counts"
      >
        {STATUS_ORDER.map((s) => {
          const sty = STATUS_STYLE[s];
          return (
            <button
              type="button"
              key={s}
              onClick={() => setFilter(filter === s ? "all" : s)}
              // These are toggle filters with a visual selected state;
              // without aria-pressed that state reaches sighted users
              // only.
              aria-pressed={filter === s}
              className="text-left border rounded-lg p-3 bg-white hover:shadow transition-shadow"
              style={{
                borderColor: filter === s ? sty.fg : "hsl(var(--line-1))",
                outline: filter === s ? `2px solid ${sty.fg}` : "none",
                outlineOffset: "-2px",
              }}
              data-testid={`fit-requests-count-${s}`}
            >
              <div
                className="text-[10px] font-bold uppercase tracking-wider mb-1"
                style={{ color: sty.fg }}
              >
                {sty.label}
              </div>
              <div
                className="text-2xl font-semibold tabular-nums"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {counts[s]}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setFilter("all")}
          disabled={filter === "all"}
          className="px-3 py-1.5 rounded text-xs font-semibold border bg-white disabled:opacity-50"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="fit-requests-filter-all"
        >
          Show all ({total})
        </button>
        <select
          value={typeFilter}
          onChange={(e) =>
            setTypeFilter(e.target.value as FitRequestType | "all")
          }
          className="px-2 py-1.5 rounded text-xs font-semibold border bg-white"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="fit-requests-type-filter"
          aria-label="Request type"
        >
          <option value="all">All request types</option>
          <option value="full_details">Details sent</option>
          <option value="callback">Callback requested</option>
        </select>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold border bg-white"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="fit-requests-refresh"
        >
          Refresh
        </button>
        <span className="text-xs text-slate-500">
          Showing {rows.length} request(s)
        </span>
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div
        className="border rounded-lg bg-white overflow-x-auto"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <table className="w-full text-sm min-w-[820px]">
          <thead style={{ backgroundColor: "#f8fafc" }}>
            <tr style={{ color: "#475569" }}>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Patient
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Fitting
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Insurance
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Waiting
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                Status
              </th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">
                CSR note
              </th>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!isPending && !isError && rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  No requests{" "}
                  {filter === "all" ? "yet" : `with status "${filter}"`}.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <RequestRow
                key={r.id}
                row={r}
                pending={pendingId === r.id}
                onPatch={(patch) => updateMut.mutate({ id: r.id, patch })}
                nowMs={nowMs}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RequestRow({
  row,
  pending,
  onPatch,
  nowMs,
}: {
  row: FitRequestRow;
  pending: boolean;
  // The API client's own input type rather than a local restatement —
  // a third field was added to the patch and this copy silently did not
  // know about it.
  onPatch: (patch: UpdateFitRequestInput) => void;
  nowMs: number;
}) {
  const [noteDraft, setNoteDraft] = useState(row.csrNote ?? "");
  /** Staged close: the row holds still and asks how it turned out. */
  const [closing, setClosing] = useState(false);
  const [outcomeDraft, setOutcomeDraft] = useState<
    FitRequestClosedOutcome | ""
  >("");
  const sty = STATUS_STYLE[row.status];
  const hasInsurance = Boolean(row.insuranceCarrier || row.memberId);

  return (
    <tr
      className="border-t align-top"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`fit-request-row-${row.id}`}
    >
      <td className="px-3 py-3">
        <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
          {row.fullName}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 break-all">
          <a className="hover:underline" href={`mailto:${row.email}`}>
            {row.email}
          </a>
        </div>
        <div className="text-xs text-slate-500">
          {row.phone ? (
            <a className="hover:underline" href={`tel:${row.phone}`}>
              {row.phone}
            </a>
          ) : (
            <span className="text-slate-400 italic">Email only</span>
          )}
          {row.dateOfBirth && (
            <>
              {" · "}
              <span className="text-slate-400">DOB {row.dateOfBirth}</span>
            </>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-1">
          Prefers: {CONTACT_METHOD_LABEL[row.preferredContactMethod]}
          {row.preferredContactTime ? ` · ${row.preferredContactTime}` : ""}
        </div>
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">
        <span
          className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={
            row.requestType === "callback"
              ? { backgroundColor: "#ede9fe", color: "#5b21b6" }
              : { backgroundColor: "#e0f2fe", color: "#075985" }
          }
        >
          {row.requestType === "callback" ? "Callback" : "Details sent"}
        </span>
        {row.population === "pediatric" && (
          <span
            className="inline-block ml-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
            style={{ backgroundColor: "#fef3c7", color: "#854d0e" }}
            title="This fitting was for a child — pediatric service line"
          >
            Pediatric
          </span>
        )}
        <div className="mt-1.5 font-semibold text-slate-800">
          {row.recommendedMaskName ?? "No mask named"}
        </div>
        {row.recommendedMaskSize && <div>Size {row.recommendedMaskSize}</div>}
        {row.notes && (
          <div className="text-slate-500 mt-1 italic" title={row.notes}>
            &ldquo;
            {row.notes.length > 80 ? `${row.notes.slice(0, 80)}…` : row.notes}
            &rdquo;
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">
        {hasInsurance ? (
          <>
            <div className="font-semibold text-slate-800">
              {row.insuranceCarrier ?? "—"}
            </div>
            {row.memberId && <div>Member {row.memberId}</div>}
            {row.groupNumber && <div>Group {row.groupNumber}</div>}
            {row.prescribingPhysician && (
              <div className="text-slate-500 mt-1">
                Rx by {row.prescribingPhysician}
              </div>
            )}
          </>
        ) : (
          // Not a gap in the data — the form makes insurance optional on
          // purpose, and a callback request never asks for it.
          <span className="text-slate-400 italic">Not provided — verify</span>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-slate-600 whitespace-nowrap">
        <div>{formatWaiting(row.createdAt, nowMs)}</div>
        {row.contactedAt && (
          <div className="text-[10px] text-slate-400 mt-0.5">
            first contacted {formatWaiting(row.contactedAt, nowMs)}
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1">
          <span
            className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider w-fit"
            style={{ backgroundColor: sty.bg, color: sty.fg }}
          >
            {sty.label}
          </span>
          {/* Closing is a TWO-FIELD submit, not a status change that
              happens to reveal a second control.

              The queue defaults to the `new` filter. Sending
              status='closed' on its own invalidates the list, the row
              leaves the current view immediately, and the outcome
              selector it was about to show goes with it — so in the
              ordinary workflow a CSR closes requests without ever
              recording an outcome, and a fulfilled fitting never gets
              its dispense stamp. That is the whole feature failing
              quietly.

              Picking "Closed" therefore stages the change instead of
              sending it: the row stays put, asks how it turned out, and
              submits status + outcome in ONE patch. */}
          <select
            value={closing ? "closed" : row.status}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.value as FitRequestStatus;
              if (next === "closed") {
                setClosing(true);
                setOutcomeDraft(row.closedOutcome ?? "");
                return;
              }
              setClosing(false);
              onPatch({ status: next });
            }}
            className="text-xs border rounded px-1 py-0.5 mt-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid={`fit-request-status-${row.id}`}
            aria-label="Request status"
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_STYLE[s].label}
              </option>
            ))}
          </select>

          {(closing || row.status === "closed") && (
            <>
              <select
                value={closing ? outcomeDraft : (row.closedOutcome ?? "")}
                disabled={pending}
                onChange={(e) => {
                  const value = e.target.value as FitRequestClosedOutcome | "";
                  if (closing) {
                    setOutcomeDraft(value);
                    return;
                  }
                  // Already closed: correction only — never clear to null
                  // (placeholder). The API rejects a null outcome-only
                  // patch on a closed row.
                  if (value === "") return;
                  onPatch({ closedOutcome: value });
                }}
                className="text-xs border rounded px-1 py-0.5 mt-1"
                style={{ borderColor: "hsl(var(--line-1))" }}
                data-testid={`fit-request-outcome-${row.id}`}
                aria-label="How it turned out"
              >
                <option value="" disabled={row.status === "closed" && !closing}>
                  How did it turn out?
                </option>
                {CLOSED_OUTCOME_ORDER.map((o) => (
                  <option key={o} value={o}>
                    {CLOSED_OUTCOME_LABEL[o]}
                  </option>
                ))}
              </select>
              {closing && (
                <div className="flex gap-2 mt-1">
                  <button
                    type="button"
                    disabled={pending || outcomeDraft === ""}
                    onClick={() => {
                      if (outcomeDraft === "") return;
                      onPatch({
                        status: "closed",
                        closedOutcome: outcomeDraft,
                      });
                      setClosing(false);
                    }}
                    className="text-xs font-semibold disabled:opacity-50"
                    style={{ color: "hsl(var(--ink-1))" }}
                    data-testid={`fit-request-confirm-close-${row.id}`}
                  >
                    {pending ? "Closing…" : "Close request"}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setClosing(false);
                      setOutcomeDraft("");
                    }}
                    className="text-xs text-slate-500 disabled:opacity-50"
                    data-testid={`fit-request-cancel-close-${row.id}`}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </>
          )}
          {row.contactedBy && (
            <span className="text-[10px] text-slate-400 mt-1">
              by {row.contactedBy}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-3">
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Add a note…"
          className="w-full text-xs border rounded p-1 resize-y"
          style={{ borderColor: "hsl(var(--line-1))", minWidth: "180px" }}
          data-testid={`fit-request-note-${row.id}`}
          aria-label="Note"
        />
        <button
          type="button"
          disabled={pending || noteDraft === (row.csrNote ?? "")}
          onClick={() =>
            onPatch({ csrNote: noteDraft.trim() === "" ? null : noteDraft })
          }
          className="mt-1 text-xs font-semibold disabled:opacity-50"
          style={{ color: "hsl(var(--ink-1))" }}
          data-testid={`fit-request-save-note-${row.id}`}
        >
          {pending ? "Saving…" : "Save note"}
        </button>
      </td>
    </tr>
  );
}
