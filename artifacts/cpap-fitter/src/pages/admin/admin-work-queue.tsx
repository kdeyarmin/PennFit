// /admin/work-queue — the unified, prioritized CSR work queue (Phase 4,
// CSR #10). Renders the F4 /admin/work-items model: everything waiting on
// you across conversations, returns, reviews, patient documents,
// follow-ups, and inbound faxes — oldest / most-overdue first, one screen
// replacing six fragmented triage surfaces. Each row deep-links to where
// the work actually gets done.
//
// requireAdmin-gated server-side (any staff). Read-only — ids +
// timestamps + kind only, no PHI in the payload.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { Badge } from "@/components/admin/Badge";
import {
  fetchWorkItems,
  type WorkItem,
  type WorkItemKind,
} from "@/lib/admin/work-items-api";

export const KIND_META: Record<
  WorkItemKind,
  {
    label: string;
    variant: "info" | "warning" | "success" | "neutral" | "muted";
  }
> = {
  conversation: { label: "Conversation", variant: "info" },
  followup: { label: "Follow-up", variant: "warning" },
  return: { label: "Return", variant: "neutral" },
  review: { label: "Review", variant: "success" },
  patient_document: { label: "Document", variant: "muted" },
  fax: { label: "Fax", variant: "muted" },
};

/**
 * Pure: where a work item deep-links so the CSR can act on it. Each kind
 * routes to the surface where that work is handled. Exported for testing.
 */
export function workItemHref(item: WorkItem): string {
  switch (item.kind) {
    case "conversation":
      return `/admin/conversations/${item.refId}`;
    case "return":
      return "/admin/shop/returns";
    case "review":
      return "/admin/shop/reviews";
    case "patient_document":
      return "/admin/patient-documents/retention";
    case "followup":
      return "/admin/followups";
    case "fax":
      return "/admin/inbound-faxes";
    default:
      return "/admin/today";
  }
}

const KINDS: WorkItemKind[] = [
  "conversation",
  "followup",
  "return",
  "review",
  "patient_document",
  "fax",
];

function relativeAge(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AdminWorkQueuePage() {
  const [kindFilter, setKindFilter] = useState<WorkItemKind | "all">("all");

  const query = useQuery({
    queryKey: ["admin", "work-items"],
    queryFn: fetchWorkItems,
    refetchInterval: 60_000,
  });

  const countsByKind = useMemo(() => {
    const acc: Partial<Record<WorkItemKind, number>> = {};
    for (const it of query.data?.workItems ?? [])
      acc[it.kind] = (acc[it.kind] ?? 0) + 1;
    return acc;
  }, [query.data]);

  const visible = useMemo(() => {
    const items = query.data?.workItems ?? [];
    return kindFilter === "all"
      ? items
      : items.filter((i) => i.kind === kindFilter);
  }, [query.data, kindFilter]);

  const nowMs = query.data ? Date.parse(query.data.serverTime) : Date.now();

  return (
    <div
      className="p-6 space-y-6 max-w-5xl"
      data-testid="admin-work-queue-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ListChecks className="h-6 w-6" />
          Work queue
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Everything waiting on you, most-urgent first — across conversations,
          follow-ups, returns, reviews, documents, and faxes. One screen instead
          of six. Refreshes once a minute.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          label="All"
          count={query.data?.count ?? 0}
          active={kindFilter === "all"}
          onClick={() => setKindFilter("all")}
        />
        {KINDS.map((k) => (
          <FilterChip
            key={k}
            label={KIND_META[k].label}
            count={countsByKind[k] ?? 0}
            active={kindFilter === k}
            onClick={() => setKindFilter(k)}
          />
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Loading the queue…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : visible.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            {query.data.count === 0
              ? "Inbox zero — nothing waiting on you. 🎉"
              : "Nothing in this category right now."}
          </p>
        </Card>
      ) : (
        <WorkTable items={visible} nowMs={nowMs} />
      )}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-slate-900 text-white"
          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
      }`}
    >
      {label}
      <span
        className={`tabular-nums ${active ? "text-slate-300" : "text-slate-500"}`}
      >
        {count}
      </span>
    </button>
  );
}

function WorkTable({ items, nowMs }: { items: WorkItem[]; nowMs: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[680px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Type</th>
            <th className="text-left px-3 py-2">Age</th>
            <th className="text-left px-3 py-2">Due</th>
            <th className="text-right px-3 py-2">Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const meta = KIND_META[it.kind];
            const overdue = it.overdueHours != null && it.overdueHours > 0;
            return (
              <tr
                key={`${it.kind}:${it.refId}`}
                className="border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-3 py-2">
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                  {relativeAge(it.createdAt, nowMs)}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums whitespace-nowrap">
                  {it.dueAt ? (
                    <span
                      style={{
                        color: overdue ? "#b91c1c" : "hsl(var(--ink-2))",
                        fontWeight: overdue ? 600 : 400,
                      }}
                    >
                      {overdue
                        ? `${it.overdueHours}h overdue`
                        : new Date(it.dueAt).toLocaleDateString()}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-xs">
                  <Link
                    href={workItemHref(it)}
                    className="underline decoration-dotted"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
