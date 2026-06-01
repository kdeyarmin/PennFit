// /admin/webhook-deliveries — outbound webhook delivery worklist +
// manual re-delivery (Biller #37).
//
// The dispatcher drains queued rows and, after exhausting its retry
// budget, parks a delivery in `exhausted`. Without a UI those silent
// failures sit until a partner complains. This page surfaces them and
// lets a supervisor re-queue a failed / exhausted delivery for
// immediate re-send (the dispatcher picks it up within ~60s).
//
// Gated server-side: list on admin.tools.manage, retry on admin-only —
// the same effective role-set, so anyone who can see this page can
// also retry. PHI posture: the list is delivery METADATA only — the
// event payload (which can carry order data) is never returned here.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Webhook } from "lucide-react";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import {
  listWebhookDeliveries,
  retryWebhookDelivery,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from "@/lib/admin/webhook-deliveries-api";

type FilterValue = WebhookDeliveryStatus | "all";

const FILTERS: ReadonlyArray<{ value: FilterValue; label: string }> = [
  { value: "exhausted", label: "Exhausted" },
  { value: "failed", label: "Failed" },
  { value: "queued", label: "Queued" },
  { value: "delivered", label: "Delivered" },
  { value: "all", label: "All" },
];

const STATUS_VARIANT: Record<
  WebhookDeliveryStatus,
  "info" | "success" | "warning" | "danger"
> = {
  queued: "info",
  delivered: "success",
  failed: "danger",
  exhausted: "warning",
};

const RETRYABLE = new Set<WebhookDeliveryStatus>(["failed", "exhausted"]);

const QUERY_KEY = ["admin", "webhook-deliveries"] as const;

export function AdminWebhookDeliveriesPage() {
  const [filter, setFilter] = useState<FilterValue>("exhausted");

  const query = useQuery({
    queryKey: [...QUERY_KEY, filter] as const,
    queryFn: () =>
      listWebhookDeliveries(filter === "all" ? undefined : { status: filter }),
    refetchInterval: 60_000,
  });

  return (
    <div
      className="p-6 space-y-6 max-w-6xl"
      data-testid="admin-webhook-deliveries-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Webhook className="h-6 w-6" />
          Webhook deliveries
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Outbound event deliveries to subscribed partner endpoints. Failed and
          exhausted deliveries can be re-queued for an immediate re-send — the
          dispatcher picks them up within about a minute. Refreshes once per
          minute.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label="Filter by delivery status"
          className="inline-flex gap-1 p-1 rounded-lg bg-slate-100"
        >
          {FILTERS.map((f) => {
            const active = f.value === filter;
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.value)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  active
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      {query.isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : query.isError ? (
        <div className="text-sm text-rose-700" role="alert">
          Couldn&apos;t load deliveries:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}.
        </div>
      ) : query.data.deliveries.length === 0 ? (
        <div className="text-sm text-slate-500" data-testid="deliveries-empty">
          No {filter === "all" ? "" : `${filter} `}deliveries.
        </div>
      ) : (
        <DeliveriesTable deliveries={query.data.deliveries} />
      )}
    </div>
  );
}

function DeliveriesTable({ deliveries }: { deliveries: WebhookDelivery[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[820px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">When</th>
            <th className="text-left px-3 py-2">Event</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-right px-3 py-2">Attempts</th>
            <th className="text-right px-3 py-2">HTTP</th>
            <th className="text-left px-3 py-2">Last error</th>
            <th className="text-right px-3 py-2">Action</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <DeliveryRow key={d.id} delivery={d} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeliveryRow({ delivery }: { delivery: WebhookDelivery }) {
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50 align-top">
      <td className="px-3 py-2 text-xs text-slate-700 tabular-nums whitespace-nowrap">
        {new Date(delivery.createdAt).toLocaleString()}
      </td>
      <td className="px-3 py-2">
        <div className="font-mono text-xs text-slate-900">
          {delivery.eventType}
        </div>
        {delivery.subscriptionId && (
          <div className="text-[11px] text-slate-400 font-mono">
            sub ··{delivery.subscriptionId.slice(-8)}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <Badge variant={STATUS_VARIANT[delivery.status]}>
          {delivery.status}
        </Badge>
      </td>
      <td className="px-3 py-2 text-xs text-slate-700 tabular-nums text-right">
        {delivery.attemptCount}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-right">
        {delivery.lastHttpStatus ?? <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-2 text-xs font-mono text-rose-700 max-w-[18rem] truncate">
        {delivery.lastError ?? <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-2 text-right">
        {RETRYABLE.has(delivery.status) ? (
          <RetryButton id={delivery.id} />
        ) : (
          <span className="text-slate-400 text-xs">—</span>
        )}
      </td>
    </tr>
  );
}

function RetryButton({ id }: { id: string }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryWebhookDelivery(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button
        intent="secondary"
        size="sm"
        isLoading={retry.isPending}
        disabled={retry.isPending || retry.isSuccess}
        onClick={() => retry.mutate()}
      >
        {retry.isSuccess ? "Re-queued" : "Retry now"}
      </Button>
      {retry.error instanceof Error && (
        <span className="text-[11px] text-rose-700">{retry.error.message}</span>
      )}
    </div>
  );
}
