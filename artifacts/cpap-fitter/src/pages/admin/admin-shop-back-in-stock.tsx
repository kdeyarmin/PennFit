// Back-in-stock queue admin page.
//
// Two things ops needs:
//   1) Visibility — "who's waiting on what?" is a restock-priority
//      signal; the SKU with 23 pending signups is the SKU you want
//      to refill first.
//   2) A manual fanout trigger — the auto-fanout fires on the
//      0->positive stock transition in the inventory editor, but
//      sometimes ops needs to push an existing positive-stock queue
//      (e.g. backorder window closed, you forgot to dispatch when
//      stock went up). The button calls the same atomic-claim path
//      as the auto trigger.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Package, Send, Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  listBackInStockQueue,
  dispatchBackInStockNow,
  type BackInStockQueueResponse,
  type BackInStockQueueRow,
} from "@/lib/admin/shop-back-in-stock-api";
import { useToast } from "@/hooks/use-toast";

const QUERY_KEY = ["admin-back-in-stock-queue"] as const;

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const days = Math.floor(diffMs / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(1, Math.floor(diffMs / 60_000));
  return `${mins}m ago`;
}

export function AdminShopBackInStockPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const queueQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listBackInStockQueue,
  });

  const dispatchMutation = useMutation({
    mutationFn: dispatchBackInStockNow,
    onSuccess: (res) => {
      toast({
        title: "Dispatch complete",
        description: `${res.delivered} delivered, ${res.failed} failed (of ${res.attempted}).`,
      });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => {
      toast({
        title: "Dispatch failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const data: BackInStockQueueResponse | undefined = queueQuery.data;
  const sortedQueue = useMemo(() => data?.queue ?? [], [data]);
  const pendingRows = sortedQueue.filter((r) => r.pendingCount > 0);

  return (
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-[hsl(var(--penn-navy))]">
          Back-in-stock queue
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Patients who asked to be notified when an out-of-stock SKU comes back.
          Auto-fanout fires when an admin saves the inventory editor and the
          stock count goes from 0 to a positive number — use the button below if
          you need to push an already-restocked SKU now.
        </p>
      </header>

      {queueQuery.isLoading ? (
        <div
          className="flex items-center justify-center py-16 text-muted-foreground"
          data-testid="back-in-stock-loading"
        >
          <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading queue…
        </div>
      ) : queueQuery.isError ? (
        <div
          className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
          data-testid="back-in-stock-error"
        >
          {queueQuery.error instanceof Error
            ? queueQuery.error.message
            : "Failed to load."}
        </div>
      ) : (
        <>
          <Totals data={data} />
          {pendingRows.length === 0 && sortedQueue.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="rounded-xl border border-border bg-white overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="bg-secondary/40 text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Product</th>
                    <th className="px-4 py-3 font-medium text-right">
                      Pending
                    </th>
                    <th className="px-4 py-3 font-medium text-right">
                      Notified
                    </th>
                    <th className="px-4 py-3 font-medium text-right">
                      Delivered
                    </th>
                    <th className="px-4 py-3 font-medium">Oldest pending</th>
                    <th className="px-4 py-3 font-medium">Last fanout</th>
                    <th className="px-4 py-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedQueue.map((row) => (
                    <Row
                      key={row.productId}
                      row={row}
                      stripeAvailable={data?.stripeAvailable ?? false}
                      busy={
                        dispatchMutation.isPending &&
                        dispatchMutation.variables === row.productId
                      }
                      onDispatch={() => dispatchMutation.mutate(row.productId)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!data?.stripeAvailable && (
            <p
              className="mt-3 text-xs text-muted-foreground"
              data-testid="back-in-stock-no-stripe"
            >
              Stripe is not configured in this environment, so product names
              show as raw ids and the dispatch button is disabled.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Totals({ data }: { data?: BackInStockQueueResponse }) {
  const totals = data?.totals ?? { pending: 0, notified: 0, delivered: 0 };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
      <Stat label="Pending" value={totals.pending} highlight />
      <Stat label="Already notified" value={totals.notified} />
      <Stat label="Delivered" value={totals.delivered} />
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        highlight
          ? "border-[hsl(var(--penn-gold))]/40 bg-amber-50"
          : "border-border bg-white"
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className="text-2xl font-bold tabular-nums text-[hsl(var(--penn-navy))]"
        data-testid={`back-in-stock-total-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function Row({
  row,
  stripeAvailable,
  busy,
  onDispatch,
}: {
  row: BackInStockQueueRow;
  stripeAvailable: boolean;
  busy: boolean;
  onDispatch: () => void;
}) {
  const showImage = Boolean(row.productImageUrl);
  return (
    <tr
      className="border-t border-border hover:bg-secondary/20 transition-colors"
      data-testid={`back-in-stock-row-${row.productId}`}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-secondary/60 flex items-center justify-center shrink-0 overflow-hidden">
            {showImage ? (
              <img
                src={row.productImageUrl!}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <Package className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <div
              className="font-medium text-[hsl(var(--penn-navy))] truncate"
              title={row.productName}
            >
              {row.productName}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {row.priceLabel ?? row.productId}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums font-semibold">
        {row.pendingCount > 0 ? (
          <span className="text-amber-700">{row.pendingCount}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {row.notifiedCount}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {row.deliveredCount}
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {formatRelative(row.oldestPendingAt)}
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {formatRelative(row.lastNotifiedAt)}
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          size="sm"
          variant={row.pendingCount > 0 ? "default" : "outline"}
          disabled={!stripeAvailable || busy || row.pendingCount === 0}
          onClick={onDispatch}
          data-testid={`back-in-stock-dispatch-${row.productId}`}
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5 mr-1.5" />
          )}
          Dispatch
        </Button>
      </td>
    </tr>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded-xl border border-dashed border-border bg-white p-10 text-center"
      data-testid="back-in-stock-empty"
    >
      <Inbox className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
      <h2 className="font-semibold text-[hsl(var(--penn-navy))]">
        No notify-me signups yet.
      </h2>
      <p className="text-sm text-muted-foreground mt-1">
        Patients can sign up from any product page once it goes out of stock.
        Their email will appear here automatically.
      </p>
    </div>
  );
}
