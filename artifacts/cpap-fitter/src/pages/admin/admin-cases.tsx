// /admin/cases — CSR case / ticket surfacing (Phase 4, CSR #17). A
// multi-channel issue (e.g. "lost order #12345" spanning an SMS, a fax,
// and a refund) gets a persistent home: open a case, set status /
// priority, and link related threads / orders / followups to it.
//
// Renders the F4 /admin/cases CRUD. cases.read to view, cases.manage to
// mutate (both in the CSR tier). Nav gated on cases.read.

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus, Link2 } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { CopyableId } from "@/components/admin/CopyableId";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Badge } from "@/components/admin/Badge";
import {
  listCases,
  getCase,
  createCase,
  patchCase,
  addCaseLink,
  type CaseLinkKind,
  type CasePriority,
  type CaseRow,
  type CaseStatus,
} from "@/lib/admin/cases-api";

const STATUSES: CaseStatus[] = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES: CasePriority[] = ["low", "normal", "high", "urgent"];
const LINK_KINDS: CaseLinkKind[] = [
  "conversation",
  "order",
  "followup",
  "fax",
  "review",
  "product_question",
  "referral",
  "work_item",
  "other",
];

const STATUS_VARIANT: Record<
  CaseStatus,
  "info" | "warning" | "success" | "muted"
> = {
  open: "info",
  in_progress: "warning",
  resolved: "success",
  closed: "muted",
};
const PRIORITY_VARIANT: Record<
  CasePriority,
  "muted" | "neutral" | "warning" | "danger"
> = {
  low: "muted",
  normal: "neutral",
  high: "warning",
  urgent: "danger",
};

const CASES_KEY = ["admin", "cases"] as const;

export function AdminCasesPage() {
  const [filter, setFilter] = useState<CaseStatus | "all">("open");
  const query = useQuery({
    queryKey: [...CASES_KEY, filter] as const,
    queryFn: () => listCases(filter),
    staleTime: 30_000,
  });

  // Which case rows are expanded. Held here (not per-row) so an
  // Expand-all / Collapse-all control can drive every row at once.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const cases = query.data?.cases ?? [];
  // "All expanded" means every *currently rendered* case is open — a plain
  // size check would be wrong if the set still holds ids from a prior
  // filter that aren't in this list.
  const allExpanded =
    cases.length > 0 && cases.every((c) => expandedIds.has(c.id));
  const toggleRow = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-6 space-y-6 max-w-4xl" data-testid="admin-cases-page">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FolderKanban className="h-6 w-6" />
          Cases
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          A persistent home for a multi-channel issue — link the threads,
          orders, faxes, and follow-ups that belong to it, and track it to
          resolution.
        </p>
      </header>

      <NewCaseCard />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div
          role="tablist"
          aria-label="Filter cases by status"
          className="inline-flex gap-1 p-1 rounded-lg bg-slate-100"
        >
          {(["open", "in_progress", "resolved", "closed", "all"] as const).map(
            (s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={s === filter}
                onClick={() => setFilter(s)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium capitalize transition-colors ${
                  s === filter
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {s.replace(/_/g, " ")}
              </button>
            ),
          )}
        </div>
        {cases.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>
              {cases.length} {cases.length === 1 ? "case" : "cases"}
            </span>
            <button
              type="button"
              onClick={() =>
                setExpandedIds(
                  allExpanded ? new Set() : new Set(cases.map((c) => c.id)),
                )
              }
              className="font-medium text-slate-600 hover:text-slate-900 hover:underline"
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}
      </div>

      {query.isPending ? (
        <Spinner label="Loading cases…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.cases.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No {filter === "all" ? "" : `${filter.replace(/_/g, " ")} `}cases.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {query.data.cases.map((c) => (
            <CaseRowItem
              key={c.id}
              caseRow={c}
              expanded={expandedIds.has(c.id)}
              onToggle={() => toggleRow(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NewCaseCard() {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<CasePriority>("normal");
  const titleInputRef = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: () => createCase({ title: title.trim(), priority }),
    onSuccess: () => {
      setTitle("");
      setPriority("normal");
      // Keep the keyboard in the form for back-to-back case entry.
      titleInputRef.current?.focus();
      void qc.invalidateQueries({ queryKey: CASES_KEY });
    },
  });

  return (
    <Card title="Open a case">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="block flex-1 min-w-[16rem]">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Title
          </span>
          <Input
            ref={titleInputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Lost order #12345 — refund + reship"
            aria-label="Case title"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Priority
          </span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as CasePriority)}
            className="rounded border border-slate-300 px-2 py-2 text-sm capitalize"
            aria-label="Case priority"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={title.trim() === "" || create.isPending}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Open case
        </Button>
      </div>
      {create.error instanceof Error && (
        <p className="mt-2 text-sm" style={{ color: "#b91c1c" }} role="alert">
          {create.error.message}
        </p>
      )}
    </Card>
  );
}

function CaseRowItem({
  caseRow,
  expanded,
  onToggle,
}: {
  caseRow: CaseRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Badge variant={STATUS_VARIANT[caseRow.status]}>
            {caseRow.status.replace(/_/g, " ")}
          </Badge>
          <Badge variant={PRIORITY_VARIANT[caseRow.priority]}>
            {caseRow.priority}
          </Badge>
          <span
            className="font-medium truncate"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {caseRow.title}
          </span>
        </span>
        <span className="text-xs text-slate-400 whitespace-nowrap">
          {new Date(caseRow.createdAt).toLocaleDateString()}
        </span>
      </button>
      {expanded && <CaseDetail caseId={caseRow.id} status={caseRow.status} />}
    </Card>
  );
}

function CaseDetail({
  caseId,
  status,
}: {
  caseId: string;
  status: CaseStatus;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["admin", "case", caseId] as const,
    queryFn: () => getCase(caseId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "case", caseId] });
    void qc.invalidateQueries({ queryKey: CASES_KEY });
  };

  const setStatus = useMutation({
    mutationFn: (s: CaseStatus) => patchCase(caseId, { status: s }),
    onSuccess: invalidate,
  });

  const [linkKind, setLinkKind] = useState<CaseLinkKind>("conversation");
  const [refId, setRefId] = useState("");
  const addLink = useMutation({
    mutationFn: () => addCaseLink(caseId, { linkKind, refId: refId.trim() }),
    onSuccess: () => {
      setRefId("");
      invalidate();
    },
  });

  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
          Status
        </span>
        <select
          value={status}
          onChange={(e) => setStatus.mutate(e.target.value as CaseStatus)}
          disabled={setStatus.isPending}
          className="rounded border border-slate-300 px-2 py-1 text-xs capitalize"
          aria-label="Set case status"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {detail.isPending ? (
        <Spinner label="Loading links…" />
      ) : detail.isError ? (
        <ErrorPanel
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <>
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
              Linked items ({detail.data.links.length})
            </p>
            {detail.data.links.length === 0 ? (
              <p className="text-xs text-slate-400">
                No linked items yet — link a thread, order, or fax below.
              </p>
            ) : (
              <ul className="space-y-1">
                {detail.data.links.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center gap-2 text-xs text-slate-700"
                  >
                    <Link2 className="h-3 w-3 text-slate-400" />
                    <span className="uppercase tracking-wider text-slate-500">
                      {l.linkKind.replace(/_/g, " ")}
                    </span>
                    <CopyableId value={l.refId} />
                    {l.note && (
                      <span className="text-slate-400">· {l.note}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap gap-2 items-end">
            <select
              value={linkKind}
              onChange={(e) => setLinkKind(e.target.value as CaseLinkKind)}
              className="rounded border border-slate-300 px-2 py-1.5 text-xs"
              aria-label="Link kind"
            >
              {LINK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <Input
              value={refId}
              onChange={(e) => setRefId(e.target.value)}
              placeholder="ref id (conversation id, order id, …)"
              aria-label="Linked ref id"
              className="font-mono text-xs w-[260px]"
            />
            <Button
              intent="secondary"
              size="sm"
              disabled={refId.trim() === "" || addLink.isPending}
              isLoading={addLink.isPending}
              onClick={() => addLink.mutate()}
            >
              Link
            </Button>
          </div>
          {addLink.error instanceof Error && (
            <p className="text-xs" style={{ color: "#b91c1c" }} role="alert">
              {addLink.error.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
