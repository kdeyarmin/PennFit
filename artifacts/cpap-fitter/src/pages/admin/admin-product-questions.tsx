// /admin/shop/product-questions — moderation queue + answer flow
// for customer-submitted product Q&A (Phase A.5 follow-up).
//
// Mirrors the shop-reviews moderation page but with a simpler
// lifecycle (pending → answered | rejected — no "approved"
// intermediate). Tabs: Pending (default) · Answered · Rejected.
//
// Pending rows render an inline "Compose answer" form + a
// "Reject" button. The compose form locks the row while the PATCH
// is in flight so a moderator can't double-submit.

import { useCallback, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, MessageSquare } from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Spinner } from "@/components/admin/Spinner";
import {
  answerAdminProductQuestion,
  listAdminProductQuestions,
  rejectAdminProductQuestion,
  AlreadyModeratedError,
  type AdminProductQuestion,
  type AdminProductQuestionStatus,
} from "@/lib/admin/product-questions-api";
import { useUrlState } from "@/hooks/use-url-state";

const TABS: ReadonlyArray<{ id: AdminProductQuestionStatus; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "answered", label: "Answered" },
  { id: "rejected", label: "Rejected" },
];

const PAGE_SIZE = 25;

const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id));
const isTab = (v: string): v is AdminProductQuestionStatus => TAB_IDS.has(v);

export function AdminProductQuestionsPage() {
  const [tab, setTab] = useUrlState<AdminProductQuestionStatus>({
    key: "tab",
    defaultValue: "pending",
    isAllowed: isTab,
  });

  return (
    <div className="space-y-6" data-testid="admin-product-questions-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Product Q&amp;A
        </h1>
        <p className="text-sm text-slate-600">
          Customer-submitted questions about shop products. Compose an answer to
          publish on the product page; reject for spam or off-topic.
        </p>
      </header>
      <div
        role="tablist"
        className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100"
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                active
                  ? "bg-white shadow-sm text-[hsl(var(--ink-1))]"
                  : "text-slate-600 hover:text-slate-900"
              }`}
              data-testid={`admin-product-questions-tab-${t.id}`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <QuestionList key={tab} status={tab} />
    </div>
  );
}

function QuestionList({ status }: { status: AdminProductQuestionStatus }) {
  const queryKey = ["admin", "product-questions", status] as const;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      listAdminProductQuestions({
        status,
        cursor: pageParam ?? undefined,
        limit: PAGE_SIZE,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  if (query.isPending) {
    return <Spinner label="Loading questions…" />;
  }
  if (query.isError) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
        {query.error instanceof Error ? query.error.message : "Failed to load."}
        <Button
          intent="ghost"
          size="sm"
          onClick={() => void query.refetch()}
          className="ml-2"
        >
          Retry
        </Button>
      </div>
    );
  }

  const allItems = query.data.pages.flatMap((p) => p.items);

  if (allItems.length === 0) {
    return (
      <p className="text-sm text-slate-600">Nothing in the {status} queue.</p>
    );
  }
  return (
    <div className="space-y-3" data-testid={`admin-product-questions-list-${status}`}>
      <ul className="space-y-3">
        {allItems.map((q) => (
          <QuestionCard key={q.id} q={q} />
        ))}
      </ul>
      {query.hasNextPage && (
        <div className="text-center pt-2">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            data-testid="admin-product-questions-load-more"
          >
            {query.isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ q }: { q: AdminProductQuestion }) {
  const qc = useQueryClient();
  const [answerDraft, setAnswerDraft] = useState("");
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["admin", "product-questions"] });
  }, [qc]);

  const answerMut = useMutation({
    mutationFn: () => answerAdminProductQuestion(q.id, answerDraft.trim()),
    onSuccess: () => {
      setAnswerDraft("");
      invalidate();
    },
    onError: (e) => {
      if (e instanceof AlreadyModeratedError) {
        // Another CSR beat us to it — refresh so the stale row clears.
        invalidate();
      }
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const rejectMut = useMutation({
    mutationFn: () =>
      rejectAdminProductQuestion(q.id, rejectNote.trim() || null),
    onSuccess: () => {
      setRejectMode(false);
      setRejectNote("");
      invalidate();
    },
    onError: (e) => {
      if (e instanceof AlreadyModeratedError) {
        // Another CSR beat us to it — refresh so the stale row clears.
        invalidate();
      }
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const trimmedAnswer = answerDraft.trim();
  const canAnswer =
    trimmedAnswer.length > 0 &&
    trimmedAnswer.length <= 2000 &&
    !answerMut.isPending;

  return (
    <li
      className="rounded-lg border border-slate-200 bg-white p-4 space-y-3"
      data-testid={`admin-product-question-${q.id}`}
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <p className="text-xs text-slate-500">
          <span className="font-mono">{q.productId}</span> ·{" "}
          {q.askerDisplayName} ({q.askerEmail}) ·{" "}
          {new Date(q.createdAt).toLocaleString()}
        </p>
        <span
          className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${
            q.status === "answered"
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
              : q.status === "rejected"
                ? "bg-rose-50 text-rose-700 border border-rose-200"
                : "bg-amber-50 text-amber-800 border border-amber-200"
          }`}
        >
          {q.status}
        </span>
      </div>

      <div>
        <p className="text-sm font-medium text-slate-900 whitespace-pre-wrap break-words">
          {q.questionBody}
        </p>
      </div>

      {q.status === "answered" && q.answerBody && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3">
          <p className="text-[11px] uppercase tracking-wider text-emerald-700 font-semibold mb-1">
            Answer · {q.answeredByEmail}
          </p>
          <p className="text-sm text-emerald-900 whitespace-pre-wrap break-words">
            {q.answerBody}
          </p>
        </div>
      )}

      {q.status === "rejected" && q.moderationNote && (
        <div className="rounded-md bg-rose-50 border border-rose-200 p-3">
          <p className="text-[11px] uppercase tracking-wider text-rose-700 font-semibold mb-1">
            Rejection note
          </p>
          <p className="text-xs text-rose-900 whitespace-pre-wrap break-words">
            {q.moderationNote}
          </p>
        </div>
      )}

      {q.status === "pending" && !rejectMode && (
        <div className="space-y-2">
          <label
            className="text-[11px] uppercase tracking-wider text-slate-600 font-semibold flex items-center gap-1"
            htmlFor={`answer-${q.id}`}
          >
            <MessageSquare className="w-3 h-3" /> Compose answer
          </label>
          <textarea
            id={`answer-${q.id}`}
            value={answerDraft}
            onChange={(e) => setAnswerDraft(e.target.value)}
            placeholder="Plain-spoken, ~1-2 sentences. Customers read this on the public product page."
            rows={3}
            maxLength={2200}
            disabled={answerMut.isPending}
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm font-sans"
            data-testid={`admin-product-question-${q.id}-answer-input`}
          />
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <span
              className={`text-[11px] ${trimmedAnswer.length > 2000 ? "text-rose-700" : "text-slate-500"}`}
            >
              {trimmedAnswer.length}/2000
            </span>
            <div className="flex gap-2">
              <Button
                intent="secondary"
                size="sm"
                onClick={() => setRejectMode(true)}
                disabled={answerMut.isPending}
                data-testid={`admin-product-question-${q.id}-reject-mode`}
              >
                <XCircle className="w-3.5 h-3.5" /> Reject
              </Button>
              <Button
                size="sm"
                onClick={() => answerMut.mutate()}
                disabled={!canAnswer}
                data-testid={`admin-product-question-${q.id}-answer-submit`}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />{" "}
                {answerMut.isPending ? "Saving…" : "Publish answer"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {q.status === "pending" && rejectMode && (
        <div className="space-y-2 rounded-md bg-rose-50 border border-rose-200 p-3">
          <label
            className="text-[11px] uppercase tracking-wider text-rose-700 font-semibold"
            htmlFor={`reject-${q.id}`}
          >
            Rejection note (optional, ≤500 chars)
          </label>
          <textarea
            id={`reject-${q.id}`}
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="Why is this off-topic / spam? Note is internal-only."
            rows={2}
            maxLength={500}
            disabled={rejectMut.isPending}
            className="w-full rounded border border-rose-300 px-3 py-2 text-sm font-sans bg-white"
            data-testid={`admin-product-question-${q.id}-reject-input`}
          />
          <div className="flex gap-2 justify-end">
            <Button
              intent="ghost"
              size="sm"
              onClick={() => setRejectMode(false)}
              disabled={rejectMut.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => rejectMut.mutate()}
              disabled={rejectMut.isPending}
              data-testid={`admin-product-question-${q.id}-reject-submit`}
            >
              {rejectMut.isPending ? "Rejecting…" : "Reject"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
