// /admin/analytics/audit-trail — the admin Audit Trail report.
//
// Shows who (which staff member) accessed which patient's information,
// when, and how — filterable by time frame, employee, patient, and
// action. Backed by GET /resupply-api/admin/patient-access-log, which
// is gated server-side by requireAdminOnly. This page is admin-only as
// well: customer-service agents are the staff being audited, so a
// non-admin who reaches the route sees a restricted notice instead.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ShieldAlert } from "lucide-react";

import { PageHeader } from "@/components/admin/PageHeader";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { useAdminRole } from "@/lib/admin/role-context";
import {
  auditTrailCsvUrl,
  fetchAuditTrail,
  type AuditTrailFilters,
} from "@/lib/admin/audit-trail-api";

const PAGE_SIZE = 100;

interface DraftFilters {
  from: string;
  to: string;
  adminEmail: string;
  patientId: string;
  action: string;
}

const EMPTY_DRAFT: DraftFilters = {
  from: "",
  to: "",
  adminEmail: "",
  patientId: "",
  action: "",
};

function toFilters(draft: DraftFilters, offset: number): AuditTrailFilters {
  return {
    from: draft.from || undefined,
    to: draft.to || undefined,
    adminEmail: draft.adminEmail.trim() || undefined,
    patientId: draft.patientId.trim() || undefined,
    action: draft.action || undefined,
    limit: PAGE_SIZE,
    offset,
  };
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function AdminAuditTrailPage() {
  const role = useAdminRole();
  const [draft, setDraft] = useState<DraftFilters>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<DraftFilters>(EMPTY_DRAFT);
  const [offset, setOffset] = useState(0);

  const filters = toFilters(applied, offset);
  const query = useQuery({
    queryKey: ["admin-audit-trail", applied, offset],
    queryFn: () => fetchAuditTrail(filters),
    enabled: role === "admin",
  });

  if (role !== "admin") {
    return (
      <div className="admin-root p-6 space-y-6 max-w-6xl">
        <PageHeader
          title="Audit Trail"
          description="Who accessed which patient's information, and when."
        />
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium">Admins only</p>
            <p>
              The audit trail is restricted to full administrators.
              Customer-service agents don&apos;t have access to this report.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const applyFilters = () => {
    setOffset(0);
    setApplied(draft);
  };
  const resetFilters = () => {
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setOffset(0);
  };

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? null;
  const hasNext =
    total !== null ? offset + PAGE_SIZE < total : rows.length === PAGE_SIZE;

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-audit-trail-page"
    >
      <PageHeader
        title="Audit Trail"
        description="Who accessed which patient's information, when, and how. Filter by time frame, employee, patient, and action."
      />

      {/* Filters */}
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          From
          <input
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          To
          <input
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Employee (email)
          <input
            type="text"
            placeholder="name@…"
            value={draft.adminEmail}
            onChange={(e) => setDraft({ ...draft, adminEmail: e.target.value })}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Patient ID
          <input
            type="text"
            placeholder="patient / customer id"
            value={draft.patientId}
            onChange={(e) => setDraft({ ...draft, patientId: e.target.value })}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Action
          <select
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All actions</option>
            <option value="view">Viewed</option>
            <option value="create">Created</option>
            <option value="update">Updated</option>
            <option value="delete">Deleted</option>
          </select>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={resetFilters}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Reset
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {total !== null
            ? `${total.toLocaleString()} event${total === 1 ? "" : "s"} match`
            : `${rows.length} event${rows.length === 1 ? "" : "s"} shown`}
        </p>
        <a
          href={auditTrailCsvUrl(toFilters(applied, 0))}
          download
          className="inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </a>
      </div>

      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
          No patient-access events match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-[920px] w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Employee
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Patient
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Record
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Request
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  IP
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                    {formatWhen(r.occurredAt)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-slate-900">{r.adminEmail}</div>
                    {r.adminRole && (
                      <div className="text-xs text-slate-400">
                        {r.adminRole}
                      </div>
                    )}
                    {r.impersonatorUserId && (
                      <div className="text-xs text-amber-600">
                        via platform admin
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-700">
                    {r.action}
                  </td>
                  <td className="px-3 py-2">
                    {r.patientName ? (
                      <div className="text-slate-900">{r.patientName}</div>
                    ) : null}
                    {r.patientId ? (
                      <div className="font-mono text-xs text-slate-400">
                        {r.patientId}
                      </div>
                    ) : (
                      !r.patientName && (
                        <span className="text-slate-300">—</span>
                      )
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    <div>{r.targetTable ?? "—"}</div>
                    {r.targetId && (
                      <div className="font-mono text-xs text-slate-400">
                        {r.targetId}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    <span className="font-mono text-xs">
                      {r.method} {r.path}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                    {r.statusCode ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-500">
                    {r.ip ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {(offset > 0 || hasNext) && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={offset === 0 || query.isFetching}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-slate-500">
            Showing {rows.length === 0 ? 0 : offset + 1}–{offset + rows.length}
            {total !== null ? ` of ${total.toLocaleString()}` : ""}
          </span>
          <button
            type="button"
            disabled={!hasNext || query.isFetching}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
