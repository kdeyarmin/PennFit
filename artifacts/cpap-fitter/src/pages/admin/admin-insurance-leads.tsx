// /admin/shop/insurance-leads — durable queue for submissions to
// the public POST /shop/insurance-leads form (the lead-capture form
// on /insurance).
//
// Page layout mirrors the abandoned-carts queue: KPI strip with
// status counts, a status filter, then a table of rows. Each row
// has inline status controls and a CSR note. PHI is shown in the
// clear because the requireAdmin gate has already cleared the
// PHI-access policy check; the page does not log per-row PHI to the
// browser console either.

import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type InsuranceLeadRow,
  type InsuranceLeadStatus,
  listInsuranceLeads,
  updateInsuranceLead,
} from "@/lib/admin/insurance-leads-api";
import { ErrorPanel } from "@/components/admin/ErrorPanel";

const STATUS_STYLE: Record<
  InsuranceLeadStatus,
  { bg: string; fg: string; label: string }
> = {
  new: { bg: "#fee2e2", fg: "#7f1d1d", label: "New" },
  contacted: { bg: "#fef3c7", fg: "#854d0e", label: "Contacted" },
  verified: { bg: "#dcfce7", fg: "#14532d", label: "Verified" },
  closed: { bg: "#f1f5f9", fg: "#475569", label: "Closed" },
};

const STATUS_ORDER: readonly InsuranceLeadStatus[] = [
  "new",
  "contacted",
  "verified",
  "closed",
];

function formatRelative(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function AdminInsuranceLeadsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<InsuranceLeadStatus | "all">("new");
  const queryKey = ["admin", "insurance-leads", filter] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listInsuranceLeads(filter),
  });

  // Track the row currently being mutated so we can disable just
  // that row's controls while the PATCH is inflight (rather than
  // graying the whole table).
  const [pendingId, setPendingId] = useState<string | null>(null);

  const updateMut = useMutation({
    mutationFn: (args: {
      id: string;
      patch: { status?: InsuranceLeadStatus; csrNote?: string | null };
    }) => updateInsuranceLead(args.id, args.patch),
    onMutate: (args) => {
      setPendingId(args.id);
    },
    onSettled: () => {
      setPendingId(null);
      // Refresh both the filtered list AND the counts strip — the
      // most common mutation is "new" → "contacted" which moves a
      // row across the filter.
      void queryClient.invalidateQueries({
        queryKey: ["admin", "insurance-leads"],
      });
    },
  });

  const rows = data?.rows ?? [];
  const counts = data?.counts ?? { new: 0, contacted: 0, verified: 0, closed: 0 };
  const total = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );
  const nowMs = Date.now();

  return (
    <div className="space-y-6" data-testid="admin-insurance-leads-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Insurance verification leads
        </h1>
        <p className="text-sm text-slate-600 max-w-2xl">
          Patients who submitted the verify-my-coverage form on{" "}
          <span className="font-mono text-xs">/insurance</span>. Mark
          each one as you work it so the queue stays a true to-do
          list. Email notifications still go out when SendGrid is
          configured; this view is the durable record.
        </p>
      </header>

      <div
        className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        data-testid="leads-counts"
      >
        {STATUS_ORDER.map((s) => {
          const sty = STATUS_STYLE[s];
          return (
            <button
              type="button"
              key={s}
              onClick={() => setFilter(filter === s ? "all" : s)}
              className="text-left border rounded-lg p-3 bg-white hover:shadow transition-shadow"
              style={{
                borderColor:
                  filter === s ? sty.fg : "hsl(var(--line-1))",
                outline: filter === s ? `2px solid ${sty.fg}` : "none",
                outlineOffset: "-2px",
              }}
              data-testid={`leads-count-${s}`}
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

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setFilter("all")}
          disabled={filter === "all"}
          className="px-3 py-1.5 rounded text-xs font-semibold border bg-white disabled:opacity-50"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="leads-filter-all"
        >
          Show all ({total})
        </button>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold border bg-white"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="leads-refresh"
        >
          Refresh
        </button>
        <span className="text-xs text-slate-500">
          Showing {rows.length} {filter === "all" ? "lead(s)" : `${filter} lead(s)`}
        </span>
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div
        className="border rounded-lg bg-white overflow-hidden"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <table className="w-full text-sm">
          <thead style={{ backgroundColor: "#f8fafc" }}>
            <tr style={{ color: "#475569" }}>
              <th className="text-left px-3 py-2 font-semibold">Patient</th>
              <th className="text-left px-3 py-2 font-semibold">Insurance</th>
              <th className="text-left px-3 py-2 font-semibold">Submitted</th>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
              <th className="text-left px-3 py-2 font-semibold">CSR note</th>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {!isPending && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No leads {filter === "all" ? "yet" : `with status "${filter}"`}.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <LeadRow
                key={r.id}
                row={r}
                pending={pendingId === r.id}
                onPatch={(patch) =>
                  updateMut.mutate({ id: r.id, patch })
                }
                nowMs={nowMs}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeadRow({
  row,
  pending,
  onPatch,
  nowMs,
}: {
  row: InsuranceLeadRow;
  pending: boolean;
  onPatch: (patch: {
    status?: InsuranceLeadStatus;
    csrNote?: string | null;
  }) => void;
  nowMs: number;
}) {
  const [noteDraft, setNoteDraft] = useState(row.csrNote ?? "");
  const sty = STATUS_STYLE[row.status];

  return (
    <tr
      className="border-t align-top"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`lead-row-${row.id}`}
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
          <a className="hover:underline" href={`tel:${row.phone}`}>
            {row.phone}
          </a>
          {" · "}
          <span className="text-slate-400">DOB {row.dateOfBirth}</span>
        </div>
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">
        <div className="font-semibold text-slate-800">
          {row.insuranceCarrier}
        </div>
        <div>Member {row.memberId}</div>
        {row.groupNumber && <div>Group {row.groupNumber}</div>}
        {row.prescribingPhysician && (
          <div className="text-slate-500 mt-1">
            Rx by {row.prescribingPhysician}
          </div>
        )}
        {row.notes && (
          <div
            className="text-slate-500 mt-1 italic"
            title={row.notes}
          >
            "{row.notes.length > 80 ? `${row.notes.slice(0, 80)}…` : row.notes}"
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-slate-600 whitespace-nowrap">
        <div>{formatRelative(row.createdAt, nowMs)}</div>
        <div className="text-[10px] text-slate-400 mt-0.5">
          {!row.notificationEmailDelivered && (
            <span title="Team notification email did not deliver">
              ⚠ team
            </span>
          )}
          {!row.confirmationEmailDelivered && (
            <span title="Patient confirmation email did not deliver" className="ml-1">
              ⚠ patient
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1">
          <span
            className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider w-fit"
            style={{ backgroundColor: sty.bg, color: sty.fg }}
          >
            {sty.label}
          </span>
          <select
            value={row.status}
            disabled={pending}
            onChange={(e) =>
              onPatch({ status: e.target.value as InsuranceLeadStatus })
            }
            className="text-xs border rounded px-1 py-0.5 mt-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid={`lead-status-${row.id}`}
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_STYLE[s].label}
              </option>
            ))}
          </select>
          {row.moderatedBy && (
            <span className="text-[10px] text-slate-400 mt-1">
              by {row.moderatedBy}
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
          data-testid={`lead-note-${row.id}`}
        />
        <button
          type="button"
          disabled={pending || noteDraft === (row.csrNote ?? "")}
          onClick={() =>
            onPatch({ csrNote: noteDraft.trim() === "" ? null : noteDraft })
          }
          className="mt-1 text-xs font-semibold disabled:opacity-50"
          style={{ color: "hsl(var(--ink-1))" }}
          data-testid={`lead-save-note-${row.id}`}
        >
          {pending ? "Saving…" : "Save note"}
        </button>
      </td>
    </tr>
  );
}
