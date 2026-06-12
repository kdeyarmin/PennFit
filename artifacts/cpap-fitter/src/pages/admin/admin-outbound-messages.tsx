// /admin/outbound-messages — outbound SMS / email send log.
//
// Every outbound message with its delivery result (delivered / sent /
// failed / pending), filterable by channel, result, and window.
// Admin / super-admin only (admin.tools.manage). Message bodies are
// not shown — this is a deliverability log, not a content viewer;
// the Thread link opens the conversation for content.

import { useState } from "react";
import { Link } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { humanizeStatus } from "@/components/admin/Badge";
import {
  fetchOutboundMessages,
  type OutboundChannelFilter,
  type OutboundMessageItem,
  type OutboundResultFilter,
} from "@/lib/admin/outbound-messages-api";

const PAGE_SIZE = 50;

const RESULT_TONE: Record<OutboundMessageItem["result"], string> = {
  delivered: "bg-emerald-100 text-emerald-900 border-emerald-300",
  sent: "bg-sky-100 text-sky-900 border-sky-300",
  failed: "bg-rose-100 text-rose-900 border-rose-300",
  pending: "bg-amber-100 text-amber-900 border-amber-300",
};

const RESULT_LABEL: Record<OutboundMessageItem["result"], string> = {
  delivered: "Delivered",
  sent: "Sent",
  failed: "Failed",
  pending: "Pending",
};

export function AdminOutboundMessagesPage() {
  const [channel, setChannel] = useState<OutboundChannelFilter>("all");
  const [result, setResult] = useState<OutboundResultFilter>("all");
  const [sinceDays, setSinceDays] = useState(14);
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ["admin-outbound-messages", channel, result, sinceDays, offset],
    queryFn: () =>
      fetchOutboundMessages({
        channel,
        result,
        sinceDays,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const setFilter = <T,>(setter: (v: T) => void) => {
    return (value: T) => {
      setter(value);
      setOffset(0);
    };
  };
  const setChannelFilter = setFilter(setChannel);
  const setResultFilter = setFilter(setResult);
  const setSinceDaysFilter = setFilter(setSinceDays);

  const data = query.data;
  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div
      className="space-y-6 max-w-6xl"
      data-testid="admin-outbound-messages-page"
    >
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Outbound messages
        </h1>
        <p className="text-sm text-slate-600">
          Every outbound SMS and email with its delivery result. Statuses are
          stamped by the Twilio and SendGrid delivery webhooks; a message stays
          “pending” until the vendor reports back. Refreshes once per minute.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label="Channel"
          className="inline-flex gap-1 p-1 rounded-lg bg-slate-100"
        >
          {(["all", "sms", "email"] as OutboundChannelFilter[]).map((c) => {
            const active = c === channel;
            const label = c === "all" ? "All" : c === "sms" ? "SMS" : "Email";
            return (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setChannelFilter(c)}
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
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Result
          <select
            value={result}
            onChange={(e) =>
              setResultFilter(e.target.value as OutboundResultFilter)
            }
            className="rounded border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="all">all</option>
            <option value="delivered">delivered</option>
            <option value="sent">sent</option>
            <option value="failed">failed</option>
            <option value="pending">pending</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600 ml-auto">
          Since
          <select
            value={sinceDays}
            onChange={(e) => setSinceDaysFilter(Number(e.target.value))}
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

      {data ? (
        <div className="flex flex-wrap gap-2">
          {(["delivered", "sent", "failed", "pending"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setResultFilter(result === k ? "all" : k)}
              aria-pressed={result === k}
              title={`Show only ${k} messages`}
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${RESULT_TONE[k]} ${
                result === k ? "ring-2 ring-offset-1 ring-slate-400" : ""
              }`}
            >
              {RESULT_LABEL[k]} · {data.counts[k]}
            </button>
          ))}
        </div>
      ) : null}

      {query.isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : query.isError ? (
        <div className="text-sm text-rose-700" role="alert">
          Couldn&apos;t load outbound messages:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}.
        </div>
      ) : data ? (
        data.items.length === 0 ? (
          <div
            className="text-sm text-slate-500"
            data-testid="outbound-messages-empty"
          >
            No outbound messages match the selected filters.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">When</th>
                    <th className="text-left px-3 py-2">Channel</th>
                    <th className="text-left px-3 py-2">Result</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Sent by</th>
                    <th className="text-left px-3 py-2">Patient</th>
                    <th className="text-left px-3 py-2">Error</th>
                    <th className="text-left px-3 py-2">Thread</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <MessageRow key={m.id} row={m} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span>
                Page {page} of {pageCount} · {total} message
                {total === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
              >
                ← Newer
              </button>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
              >
                Older →
              </button>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

function MessageRow({ row }: { row: OutboundMessageItem }) {
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
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${RESULT_TONE[row.result]}`}
        >
          {RESULT_LABEL[row.result]}
        </span>
      </td>
      <td
        className="px-3 py-2 text-xs text-slate-600"
        title={
          row.deliveredAt
            ? `Delivered ${new Date(row.deliveredAt).toLocaleString()}`
            : undefined
        }
      >
        {row.deliveryStatus ? humanizeStatus(row.deliveryStatus) : "—"}
      </td>
      <td className="px-3 py-2 text-xs text-slate-600">
        {humanizeStatus(row.senderRole)}
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
        <Link
          href={`/admin/conversations/${row.conversationId}`}
          className="underline decoration-dotted"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Open thread →
        </Link>
      </td>
    </tr>
  );
}
