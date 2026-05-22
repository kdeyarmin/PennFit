// /admin/shop/returns — comfort-guarantee return / RMA queue.
//
// Layout: status-tab strip with "Open" as the default landing tab
// (covers requested + approved + shipped_back + received) plus
// per-status drill-downs and an All view. Each row is a card with
// the customer's reason + note, lifecycle timestamps, and action
// buttons gated by current status.
//
// Action buttons:
//   requested      → Approve · Reject
//   approved       → Mark shipped back · Mark received
//                    (the in-transit step is optional — admins can
//                    skip straight to "received" when ops scans
//                    inbound parcel directly).
//   shipped_back   → Mark received
//   received       → Refund · Replace
//
// All other states are terminal — only the Add note button remains
// for posterity.

import { useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  approveReturn,
  listAdminShopReturns,
  markReceived,
  markShipped,
  noteReturn,
  refundReturn,
  rejectReturn,
  replaceReturn,
  type AdminReturn,
  type ReturnStatus,
} from "@/lib/admin/shop-returns-api";
import { ReturnNotesPanel } from "@/components/admin/ReturnNotesPanel";

type Tab = ReturnStatus | "all" | "open";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "open", label: "Open" },
  { id: "requested", label: "Requested" },
  { id: "approved", label: "Approved" },
  { id: "shipped_back", label: "In transit" },
  { id: "received", label: "Received" },
  { id: "refunded", label: "Refunded" },
  { id: "replaced", label: "Replaced" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

const PAGE_SIZE = 25;

const TAB_IDS: ReadonlySet<Tab> = new Set(TABS.map((t) => t.id));

function readTabFromUrl(): Tab {
  if (typeof window === "undefined") return "open";
  const raw = new URLSearchParams(window.location.search).get("tab");
  return raw && TAB_IDS.has(raw as Tab) ? (raw as Tab) : "open";
}

export function AdminShopReturnsPage() {
  // Persist the active tab in `?tab=<id>` so a refresh, back/forward
  // nav, or bookmarked link lands on the same view. The "open" default
  // is omitted from the URL.
  const [tab, setTabState] = useState<Tab>(() => readTabFromUrl());

  function setTab(next: Tab) {
    setTabState(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next === "open") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    const newUrl =
      window.location.pathname +
      (qs ? `?${qs}` : "") +
      window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }

  useEffect(() => {
    function handlePopstate() {
      setTabState(readTabFromUrl());
    }
    window.addEventListener("popstate", handlePopstate);
    return () => {
      window.removeEventListener("popstate", handlePopstate);
    };
  }, []);

  return (
    <div className="space-y-6" data-testid="admin-shop-returns-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Returns &amp; RMAs
        </h1>
        <p className="text-sm text-slate-600">
          Process customer return requests under the 60-day comfort guarantee.
          Each row advances through a strict state machine; admin notes are
          appended newest-first.
        </p>
      </header>
      <TabStrip tab={tab} onChange={setTab} />
      <ReturnsList key={tab} tab={tab} />
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
      className="inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-100"
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
            data-testid={`shop-returns-tab-${t.id}`}
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

function ReturnsList({ tab }: { tab: Tab }) {
  const query = useInfiniteQuery({
    queryKey: ["admin-shop-returns", tab],
    queryFn: ({ pageParam }) =>
      listAdminShopReturns({
        status: tab,
        cursor: typeof pageParam === "string" ? pageParam : undefined,
        limit: PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.returns) ?? [],
    [query.data],
  );

  if (query.isPending) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className="text-sm text-rose-700" role="alert">
        Couldn&apos;t load returns:{" "}
        {query.error instanceof Error ? query.error.message : "unknown error"}.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="text-sm text-slate-500" data-testid="shop-returns-empty">
        No returns in this state.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {rows.map((r) => (
          <ReturnCard key={r.id} item={r} />
        ))}
      </ul>
      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-200 hover:bg-slate-50 disabled:opacity-60"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

const REASON_LABELS: Record<string, string> = {
  fit: "Doesn't fit",
  defective: "Defective / damaged",
  wrong_item: "Wrong item received",
  no_longer_needed: "No longer needed",
  other: "Other",
};

const STATUS_TONE: Record<ReturnStatus, string> = {
  requested: "bg-amber-100 text-amber-900 border-amber-300",
  approved: "bg-blue-100 text-blue-900 border-blue-300",
  shipped_back: "bg-indigo-100 text-indigo-900 border-indigo-300",
  received: "bg-violet-100 text-violet-900 border-violet-300",
  refunded: "bg-emerald-100 text-emerald-900 border-emerald-300",
  replaced: "bg-emerald-100 text-emerald-900 border-emerald-300",
  rejected: "bg-rose-100 text-rose-900 border-rose-300",
  closed: "bg-slate-200 text-slate-700 border-slate-300",
};

function ReturnCard({ item }: { item: AdminReturn }) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin-shop-returns"] });

  const approveMut = useMutation({
    mutationFn: () => approveReturn(item.id, {}),
    onSuccess: invalidate,
  });
  const rejectMut = useMutation({
    mutationFn: (note: string) => rejectReturn(item.id, note),
    onSuccess: invalidate,
  });
  const shippedMut = useMutation({
    mutationFn: () => markShipped(item.id),
    onSuccess: invalidate,
  });
  const receivedMut = useMutation({
    mutationFn: () => markReceived(item.id),
    onSuccess: invalidate,
  });
  const refundMut = useMutation({
    mutationFn: (amountCents?: number) =>
      refundReturn(item.id, amountCents ? { amountCents } : {}),
    onSuccess: invalidate,
  });
  const replaceMut = useMutation({
    mutationFn: (body: {
      exchangeProductId: string;
      exchangePriceId: string;
    }) => replaceReturn(item.id, body),
    onSuccess: invalidate,
  });
  const noteMut = useMutation({
    mutationFn: (note: string) => noteReturn(item.id, note),
    onSuccess: invalidate,
  });

  const [rejectNote, setRejectNote] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replaceProductId, setReplaceProductId] = useState("");
  const [replacePriceId, setReplacePriceId] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [extraNote, setExtraNote] = useState("");
  // Phase 15: append-only internal notes log, separate from the
  // single-blob `adminNote` field that gets accumulated alongside
  // status transitions.
  const [showNotesLog, setShowNotesLog] = useState(false);

  const errorMessage =
    approveMut.error instanceof Error
      ? approveMut.error.message
      : rejectMut.error instanceof Error
        ? rejectMut.error.message
        : shippedMut.error instanceof Error
          ? shippedMut.error.message
          : receivedMut.error instanceof Error
            ? receivedMut.error.message
            : refundMut.error instanceof Error
              ? refundMut.error.message
              : replaceMut.error instanceof Error
                ? replaceMut.error.message
                : noteMut.error instanceof Error
                  ? noteMut.error.message
                  : null;

  return (
    <li
      className="rounded-lg border border-slate-200 bg-white p-4"
      data-testid={`shop-return-${item.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[item.status]}`}
            >
              {item.status.replace(/_/g, " ")}
            </span>
            <span className="text-xs text-slate-600">
              {REASON_LABELS[item.reason] ?? item.reason}
            </span>
          </div>
          <div className="text-sm font-mono text-slate-700">
            Order {item.sessionId.slice(-12)}
          </div>
          <div className="text-xs text-slate-500">
            Customer {item.customerId.slice(-10)} · opened{" "}
            {new Date(item.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="text-right text-xs text-slate-500 shrink-0">
          {item.resolution && (
            <div className="font-semibold text-slate-700">
              Resolution: {item.resolution}
              {item.refundCents !== null && (
                <> · ${(item.refundCents / 100).toFixed(2)}</>
              )}
            </div>
          )}
          {item.stripeRefundId && (
            <div className="font-mono">{item.stripeRefundId}</div>
          )}
        </div>
      </div>

      {item.reasonNote && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-sm text-slate-800">
          <span className="font-semibold text-slate-600">Customer note: </span>
          {item.reasonNote}
        </div>
      )}

      {item.adminNote && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600">
            Status-change rationale
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
            {item.adminNote}
          </pre>
        </details>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowNotesLog((v) => !v)}
          className="text-xs font-semibold text-slate-600 underline decoration-dotted"
          aria-expanded={showNotesLog}
          data-testid={`return-${item.id}-notes-toggle`}
        >
          {showNotesLog ? "Hide internal notes" : "Internal notes"}
        </button>
        {showNotesLog && <ReturnNotesPanel returnId={item.id} />}
      </div>

      {errorMessage && (
        <div className="mt-3 text-xs text-rose-700" role="alert">
          {errorMessage}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {item.status === "requested" && (
          <>
            <button
              type="button"
              onClick={() => approveMut.mutate()}
              disabled={approveMut.isPending}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              data-testid={`return-${item.id}-approve`}
            >
              {approveMut.isPending ? "Approving…" : "Approve"}
            </button>
            {!showReject ? (
              <button
                type="button"
                onClick={() => setShowReject(true)}
                className="rounded border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
              >
                Reject
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value.slice(0, 500))}
                  placeholder="Reason for rejection (optional)"
                  className="rounded border border-slate-300 px-2 py-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={() => rejectMut.mutate(rejectNote)}
                  disabled={rejectMut.isPending}
                  className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  {rejectMut.isPending ? "Rejecting…" : "Confirm reject"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReject(false)}
                  className="text-xs text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
        {item.status === "approved" && (
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  "Mark this return as shipped back? Use this when the customer confirms they've handed off the parcel, before it physically arrives.",
                )
              )
                shippedMut.mutate();
            }}
            disabled={shippedMut.isPending}
            className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            data-testid={`return-${item.id}-mark-shipped`}
          >
            {shippedMut.isPending ? "Marking…" : "Mark shipped back"}
          </button>
        )}
        {(item.status === "approved" || item.status === "shipped_back") && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Mark this return as received? This advances the return to the refund/replace stage."))
                receivedMut.mutate();
            }}
            disabled={receivedMut.isPending}
            className="rounded bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
            data-testid={`return-${item.id}-mark-received`}
          >
            {receivedMut.isPending ? "Marking…" : "Mark received"}
          </button>
        )}
        {item.status === "received" && (
          <>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Issue a full refund for this return? This action cannot be undone."))
                  refundMut.mutate(undefined);
              }}
              disabled={refundMut.isPending}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              data-testid={`return-${item.id}-refund`}
            >
              {refundMut.isPending ? "Refunding…" : "Refund full amount"}
            </button>
            {!showReplace ? (
              <button
                type="button"
                onClick={() => setShowReplace(true)}
                className="rounded border border-emerald-300 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
              >
                Issue replacement
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={replaceProductId}
                  onChange={(e) => setReplaceProductId(e.target.value)}
                  placeholder="prod_xxx"
                  className="rounded border border-slate-300 px-2 py-1.5 text-xs font-mono"
                />
                <input
                  type="text"
                  value={replacePriceId}
                  onChange={(e) => setReplacePriceId(e.target.value)}
                  placeholder="price_xxx"
                  className="rounded border border-slate-300 px-2 py-1.5 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Send replacement product ${replaceProductId} at price ${replacePriceId}? This creates a new order for the customer.`))
                      replaceMut.mutate({
                        exchangeProductId: replaceProductId,
                        exchangePriceId: replacePriceId,
                      });
                  }}
                  disabled={
                    replaceMut.isPending || !replaceProductId || !replacePriceId
                  }
                  className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {replaceMut.isPending ? "Saving…" : "Confirm replace"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReplace(false)}
                  className="text-xs text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
        {!showNote ? (
          <button
            type="button"
            onClick={() => setShowNote(true)}
            className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Add note
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2 w-full">
            <input
              type="text"
              value={extraNote}
              onChange={(e) => setExtraNote(e.target.value.slice(0, 2000))}
              placeholder="Internal note (≤2000 chars)"
              className="flex-1 min-w-[16rem] rounded border border-slate-300 px-2 py-1.5 text-xs"
            />
            <button
              type="button"
              onClick={() => {
                if (!extraNote) return;
                noteMut.mutate(extraNote);
                setExtraNote("");
                setShowNote(false);
              }}
              disabled={noteMut.isPending || !extraNote}
              className="rounded bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {noteMut.isPending ? "Saving…" : "Save note"}
            </button>
            <button
              type="button"
              onClick={() => setShowNote(false)}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
