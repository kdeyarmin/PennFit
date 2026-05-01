// /admin/shop/reviews — moderation queue for the cash-pay shop.
//
// Layout: status-tab strip (Pending | Approved | Rejected | All) +
// scrollable list of review cards with inline approve / reject
// actions. Reject opens an inline note textarea (≤500 chars) per the
// API contract. Once an action succeeds we optimistically remove the
// row from the current tab so the moderator sees the queue shrink.
//
// We deliberately render review bodies as plain text (no innerHTML);
// the API already strips script/style + tags, but rendering as text
// is a defense-in-depth.
//
// "Pending" is the default landing tab because that's the only state
// requiring action — the others are read-only audit views.

import { useCallback, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type AdminReview,
  type ReviewStatus,
  approveAdminShopReview,
  listAdminShopReviews,
  rejectAdminShopReview,
  unrejectAdminShopReview,
  updateAdminShopReviewNote,
} from "../lib/shop-reviews-api";

type Tab = ReviewStatus | "all";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

const PAGE_SIZE = 25;

export function AdminShopReviewsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  return (
    <div className="space-y-6" data-testid="admin-shop-reviews-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Shop reviews
        </h1>
        <p className="text-sm text-slate-600">
          Approve or reject customer reviews before they appear on the
          public shop.
        </p>
      </header>
      <TabStrip tab={tab} onChange={setTab} />
      <ReviewsList key={tab} tab={tab} />
    </div>
  );
}

function TabStrip({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (next: Tab) => void;
}) {
  return (
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
            onClick={() => onChange(t.id)}
            data-testid={`shop-reviews-tab-${t.id}`}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors font-medium ${
              active
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function ReviewsList({ tab }: { tab: Tab }) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "shop-reviews", tab] as const;

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      listAdminShopReviews({
        status: tab,
        cursor: pageParam ?? undefined,
        limit: PAGE_SIZE,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  // Optimistically removes a row from the current tab's pages — used
  // by both approve + reject, since the row drops out of the tab the
  // moderator is currently looking at.
  const removeRowFromCache = useCallback(
    (id: string) => {
      queryClient.setQueryData<typeof query.data>(queryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map((p) => ({
            ...p,
            items: p.items.filter((item) => item.id !== id),
          })),
        };
      });
    },
    [queryClient, queryKey, query.data],
  );

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveAdminShopReview(id),
    onSuccess: (_, id) => {
      // Drop from current tab; "Approved" + "All" tabs are reloaded
      // when the moderator switches because each tab has its own key.
      if (tab !== "approved" && tab !== "all") removeRowFromCache(id);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string | null }) =>
      rejectAdminShopReview(id, note),
    onSuccess: (_, { id }) => {
      if (tab !== "rejected" && tab !== "all") removeRowFromCache(id);
    },
  });

  // Un-reject (rejected → pending). On the "rejected" tab, the row
  // drops out (it's no longer rejected). On the "all" tab we leave
  // it in place but the status badge will refresh on next refetch;
  // we trigger an invalidation so the badge updates promptly.
  const unrejectMutation = useMutation({
    mutationFn: (id: string) => unrejectAdminShopReview(id),
    onSuccess: (_, id) => {
      if (tab === "rejected") removeRowFromCache(id);
      else void queryClient.invalidateQueries({ queryKey });
    },
  });

  // PATCH the rejection note on an already-rejected review. We
  // optimistically rewrite the note in the cache so the form closes
  // immediately + the new text is visible without a refetch.
  const noteMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string | null }) =>
      updateAdminShopReviewNote(id, note),
    onSuccess: (resp) => {
      queryClient.setQueryData<typeof query.data>(queryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map((p) => ({
            ...p,
            items: p.items.map((it) =>
              it.id === resp.id
                ? { ...it, moderationNote: resp.moderationNote }
                : it,
            ),
          })),
        };
      });
    },
  });

  if (query.isPending) {
    return (
      <div className="text-sm text-slate-500 py-12 text-center">
        Loading reviews…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-4">
        Couldn&apos;t load reviews:{" "}
        {query.error instanceof Error ? query.error.message : "Unknown error"}
      </div>
    );
  }

  const allItems = query.data.pages.flatMap((p) => p.items);
  if (allItems.length === 0) {
    return (
      <div
        className="text-sm text-slate-500 py-16 text-center border border-dashed border-slate-300 rounded-xl"
        data-testid="shop-reviews-empty"
      >
        {tab === "pending"
          ? "Nothing to moderate right now."
          : "No reviews in this view."}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="shop-reviews-list">
      {allItems.map((r) => (
        <ReviewRow
          key={r.id}
          review={r}
          onApprove={() => approveMutation.mutate(r.id)}
          onReject={(note) => rejectMutation.mutate({ id: r.id, note })}
          onUnreject={() => unrejectMutation.mutate(r.id)}
          onSaveNote={(note) => noteMutation.mutate({ id: r.id, note })}
          approving={
            approveMutation.isPending && approveMutation.variables === r.id
          }
          rejecting={
            rejectMutation.isPending && rejectMutation.variables?.id === r.id
          }
          unrejecting={
            unrejectMutation.isPending && unrejectMutation.variables === r.id
          }
          savingNote={
            noteMutation.isPending && noteMutation.variables?.id === r.id
          }
        />
      ))}
      {query.hasNextPage && (
        <div className="text-center pt-2">
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            data-testid="shop-reviews-load-more"
          >
            {query.isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewRow({
  review,
  onApprove,
  onReject,
  onUnreject,
  onSaveNote,
  approving,
  rejecting,
  unrejecting,
  savingNote,
}: {
  review: AdminReview;
  onApprove: () => void;
  onReject: (note: string | null) => void;
  onUnreject: () => void;
  onSaveNote: (note: string | null) => void;
  approving: boolean;
  rejecting: boolean;
  unrejecting: boolean;
  savingNote: boolean;
}) {
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [note, setNote] = useState("");
  // Edit-note form state (only opens for rejected reviews). Seeded
  // with the existing moderationNote so admins iterate, not retype.
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const busy = approving || rejecting || unrejecting || savingNote;

  return (
    <article
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid={`shop-review-row-${review.id}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm">
            <Stars value={review.rating} />
            <span className="font-semibold text-slate-700">
              {review.rating}/5
            </span>
            <StatusBadge status={review.status} />
          </div>
          {review.title && (
            <h3 className="font-semibold text-slate-900 mt-2">
              {review.title}
            </h3>
          )}
        </div>
        <div className="text-right text-xs text-slate-500 shrink-0">
          <div className="font-semibold text-slate-700">
            {review.authorDisplayName}
          </div>
          <div className="font-mono">{review.authorEmail}</div>
          <div className="mt-0.5">
            {new Date(review.createdAt).toLocaleString()}
          </div>
          <div className="font-mono text-slate-400 mt-0.5">
            {review.productId}
          </div>
        </div>
      </header>
      <p className="text-sm text-slate-700 leading-relaxed mt-3 whitespace-pre-wrap">
        {review.body}
      </p>
      {review.status === "rejected" && !editingNote && (
        <div className="mt-3 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
          {review.moderationNote ? (
            <p>
              <span className="font-semibold">
                Customer-visible note:
              </span>{" "}
              {review.moderationNote}
            </p>
          ) : (
            <p className="italic text-slate-500">
              No customer-visible note. Add one if context would help.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setEditingNote(true);
                setNoteDraft(review.moderationNote ?? "");
              }}
              disabled={busy}
              data-testid={`shop-review-edit-note-open-${review.id}`}
              className="text-xs font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900 disabled:opacity-50"
            >
              Edit note
            </button>
            <button
              type="button"
              onClick={onUnreject}
              disabled={busy}
              data-testid={`shop-review-unreject-${review.id}`}
              className="text-xs font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900 disabled:opacity-50"
            >
              {unrejecting ? "Re-opening…" : "Un-reject (back to queue)"}
            </button>
          </div>
        </div>
      )}
      {review.status === "rejected" && editingNote && (
        <div
          className="mt-3 space-y-2"
          data-testid={`shop-review-edit-note-form-${review.id}`}
        >
          <label className="block text-xs font-semibold text-slate-700">
            Customer-visible note (≤500 chars). Saving doesn&apos;t
            re-send the rejection email — that already went out.
          </label>
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            maxLength={500}
            rows={3}
            className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
            data-testid={`shop-review-edit-note-input-${review.id}`}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">
              {noteDraft.length} / 500
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditingNote(false);
                  setNoteDraft("");
                }}
                disabled={busy}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onSaveNote(noteDraft.trim() || null);
                  setEditingNote(false);
                }}
                disabled={busy}
                data-testid={`shop-review-edit-note-save-${review.id}`}
                className="px-3 py-1.5 text-xs font-medium rounded-lg text-white shadow-sm disabled:opacity-50"
                style={{ backgroundColor: "#0a1f44" }}
              >
                {savingNote ? "Saving…" : "Save note"}
              </button>
            </div>
          </div>
        </div>
      )}
      {review.status === "pending" && !showRejectForm && (
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            data-testid={`shop-review-approve-${review.id}`}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white shadow-sm disabled:opacity-50"
            style={{ backgroundColor: "#0a1f44" }}
          >
            {approving ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setShowRejectForm(true)}
            disabled={busy}
            data-testid={`shop-review-reject-open-${review.id}`}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )}
      {showRejectForm && (
        <div
          className="mt-4 space-y-2"
          data-testid={`shop-review-reject-form-${review.id}`}
        >
          <label className="block text-xs font-semibold text-slate-700">
            Reason (optional, ≤500 chars — visible to the customer)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="e.g. Please remove personally identifying details and resubmit."
            className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
            data-testid={`shop-review-reject-note-${review.id}`}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">
              {note.length} / 500
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowRejectForm(false);
                  setNote("");
                }}
                disabled={busy}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onReject(note.trim() || null)}
                disabled={busy}
                data-testid={`shop-review-reject-confirm-${review.id}`}
                className="px-3 py-1.5 text-xs font-medium rounded-lg text-white shadow-sm disabled:opacity-50"
                style={{ backgroundColor: "#9b2c2c" }}
              >
                {rejecting ? "Rejecting…" : "Confirm reject"}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function Stars({ value }: { value: number }) {
  // Compact text-only star display so this page has zero new visual
  // dependencies. The customer-facing /shop is where pretty SVG stars
  // live; the moderation queue prioritizes density + scanability.
  const filled = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span aria-label={`${value} out of 5 stars`} className="text-amber-500">
      {"★".repeat(filled)}
      <span className="text-slate-300">{"★".repeat(5 - filled)}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: ReviewStatus }) {
  const styles: Record<ReviewStatus, string> = {
    pending: "bg-amber-50 text-amber-800 border-amber-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-rose-50 text-rose-700 border-rose-200",
  };
  const labels: Record<ReviewStatus, string> = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}
