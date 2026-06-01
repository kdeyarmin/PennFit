// /admin/delivery-failures — webhook delivery error triage queue.
//
// Two tabs: "Message failures" (per-message terminal failure states
// from SMS/email/voice status callbacks) and "System events"
// (delivery-failure-shaped audit_log rows). Operators use this to
// spot phone numbers that bounce, addresses landing in spam, etc.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

import { humanizeAction, humanizeStatus } from "@/components/admin/Badge";
import {
  fetchDeliveryFailures,
  type AuditFailureEvent,
  type DeliveryFailuresResponse,
  type MessageFailureEvent,
} from "@/lib/admin/delivery-failures-api";

type Tab = "messages" | "audit";

export function AdminDeliveryFailuresPage() {
  const [tab, setTab] = useState<Tab>("messages");
  const [sinceDays, setSinceDays] = useState(14);

  const query = useQuery({
    queryKey: ["admin-delivery-failures", sinceDays],
    queryFn: () => fetchDeliveryFailures(sinceDays),
    refetchInterval: 60_000,
  });

  return (
    <div
      className="space-y-6 max-w-6xl"
      data-testid="admin-delivery-failures-page"
    >
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Delivery failures
        </h1>
        <p className="text-sm text-slate-600">
          Recent message-send failures across SMS, email, and voice, plus
          delivery-failure-shaped audit events. Refreshes once per minute.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          className="inline-flex gap-1 p-1 rounded-lg bg-slate-100"
        >
          {(["messages", "audit"] as Tab[]).map((t) => {
            const active = t === tab;
            const label =
              t === "messages" ? "Message failures" : "System events";
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  active
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600 ml-auto">
          Since
          <select
            value={sinceDays}
            onChange={(e) => setSinceDays(Number(e.target.value))}
            className="rounded border border-slate-300 px-2 py-1 text-xs"
          >
            <option value={1}>last 24 hours</option>
            <option value={7}>last 7 days</option>
            <option value={14}>last 14 days</option>
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
          </select>
        </label>
      </div>

      {query.isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : query.isError ? (
        <div className="text-sm text-rose-700" role="alert">
          Couldn&apos;t load failures:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}.
        </div>
      ) : query.data ? (
        tab === "messages" ? (
          <MessageFailuresTable data={query.data} />
        ) : (
          <AuditFailuresTable data={query.data} />
        )
      ) : null}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  failed: "bg-rose-100 text-rose-900 border-rose-300",
  undelivered: "bg-rose-100 text-rose-900 border-rose-300",
  bounced: "bg-rose-100 text-rose-900 border-rose-300",
  dropped: "bg-amber-100 text-amber-900 border-amber-300",
  rejected: "bg-rose-100 text-rose-900 border-rose-300",
  spam_report: "bg-rose-100 text-rose-900 border-rose-300",
};

function MessageFailuresTable({ data }: { data: DeliveryFailuresResponse }) {
  const rows = data.messageEvents;

  // Group by deliveryStatus + channel for the summary strip.
  const byStatus = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const r of rows) {
      const k = r.deliveryStatus ?? "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
    }
    return acc;
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="text-sm text-slate-500" data-testid="failures-empty">
        No message failures in the selected window.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {Object.entries(byStatus).map(([status, count]) => (
          <span
            key={status}
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
              STATUS_TONE[status] ??
              "bg-slate-100 text-slate-700 border-slate-300"
            }`}
          >
            {humanizeStatus(status)} · {count}
          </span>
        ))}
      </div>
      <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Channel</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Patient</th>
              <th className="text-left px-3 py-2">Error</th>
              <th className="text-left px-3 py-2">Thread</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <MessageRow key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MessageRow({ row }: { row: MessageFailureEvent }) {
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="px-3 py-2 text-xs text-slate-700 tabular-nums whitespace-nowrap">
        {new Date(row.occurredAt).toLocaleString()}
      </td>
      <td className="px-3 py-2 text-xs uppercase tracking-wider text-slate-600">
        {row.channel ?? "—"}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
            (row.deliveryStatus && STATUS_TONE[row.deliveryStatus]) ??
            "bg-slate-100 text-slate-700 border-slate-300"
          }`}
        >
          {humanizeStatus(row.deliveryStatus)}
        </span>
      </td>
      <td className="px-3 py-2 text-sm">
        {row.patientId ? (
          <Link
            href={`/admin/patients/${row.patientId}`}
            className="underline decoration-dotted"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {row.patientName?.trim() || "(no name)"}
          </Link>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs font-mono text-rose-700">
        {row.deliveryError ?? "—"}
      </td>
      <td className="px-3 py-2 text-xs">
        {row.conversationId ? (
          <Link
            href={`/admin/conversations/${row.conversationId}`}
            className="underline decoration-dotted"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Open thread →
          </Link>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}

function AuditFailuresTable({ data }: { data: DeliveryFailuresResponse }) {
  if (data.auditEventsUnavailable) {
    return (
      <div
        className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600"
        role="status"
        data-testid="audit-events-unavailable"
      >
        System events are no longer tracked. The underlying audit log was
        retired; only per-message failures (above) remain.
      </div>
    );
  }
  const rows = data.auditEvents;
  if (rows.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No system delivery events in the selected window.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[720px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">When</th>
            <th className="text-left px-3 py-2">Action</th>
            <th className="text-left px-3 py-2">Target</th>
            <th className="text-left px-3 py-2">Actor</th>
            <th className="text-left px-3 py-2">Metadata</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <AuditRow key={r.id} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditRow({ row }: { row: AuditFailureEvent }) {
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 text-xs text-slate-700 tabular-nums whitespace-nowrap">
        {new Date(row.occurredAt).toLocaleString()}
      </td>
      <td className="px-3 py-2 text-xs text-slate-900" title={row.action}>
        {humanizeAction(row.action)}
      </td>
      <td className="px-3 py-2 text-xs">
        {row.targetTable ? (
          <span className="text-slate-700" title={row.targetTable}>
            {humanizeAction(row.targetTable)}
            {row.targetId ? ` · ${row.targetId.slice(-12)}` : ""}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-slate-700">
        {row.actorEmail ?? <span className="text-slate-400">system</span>}
      </td>
      <td className="px-3 py-2 text-[11px] text-slate-600">
        {row.metadata ? (
          <details>
            <summary className="cursor-pointer">show</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words bg-slate-50 p-2 rounded">
              {JSON.stringify(row.metadata, null, 2)}
            </pre>
          </details>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}
