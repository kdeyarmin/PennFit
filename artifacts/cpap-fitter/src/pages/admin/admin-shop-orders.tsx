// /admin/shop/orders — paid storefront order workspace.
//
// Pattern B from the domain workflow review: paid `shop_orders` had no
// list/detail page at all — staff could not look up an arbitrary order, see
// its line items, or act on it, even though the "set tracking / mark
// delivered / refund" endpoints already existed (they appeared on no
// screen). The /admin/fitter/orders entry is the read-only AI-fitter
// request log, NOT these paid orders — hence this dedicated workspace.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingBag } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { Badge } from "@/components/admin/Badge";
import { Pagination } from "@/components/admin/Pagination";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { formatAppDateTime } from "@/lib/utils";
import {
  getShopOrder,
  listShopOrders,
  markShopOrderDelivered,
  refundShopOrder,
  setShopOrderTracking,
  type AdminShopOrderListItem,
} from "@/lib/admin/shop-orders-api";

const LIMIT = 25;

const STATUS_FILTER_OPTIONS = [
  { value: "paid", label: "Paid" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "refunded", label: "Refunded" },
  { value: "ready_for_pickup", label: "Ready for pickup" },
  { value: "picked_up", label: "Picked up" },
];

function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function statusVariant(
  status: string,
): "neutral" | "info" | "success" | "warning" {
  switch (status) {
    case "paid":
      return "info";
    case "shipped":
    case "ready_for_pickup":
      return "neutral";
    case "delivered":
    case "picked_up":
      return "success";
    case "refunded":
      return "warning";
    default:
      return "neutral";
  }
}

export function AdminShopOrdersPage() {
  useDocumentTitle("Shop orders");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [offset, setOffset] = useState(0);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const list = useQuery({
    queryKey: ["admin-shop-orders", status, debounced, offset],
    queryFn: () =>
      listShopOrders({
        status: status || undefined,
        q: debounced || undefined,
        limit: LIMIT,
        offset,
      }),
    staleTime: 15_000,
  });

  // Reset to the first page whenever the filters change.
  useEffect(() => setOffset(0), [status, debounced]);

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-shop-orders"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShoppingBag className="h-6 w-6" />
          Shop orders
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Paid storefront orders — look one up, review its line items, set
          tracking, mark it delivered, or refund it.
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Label htmlFor="shop-orders-status">Status</Label>
            <Select
              id="shop-orders-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={STATUS_FILTER_OPTIONS}
              emptyOptionLabel="All statuses"
            />
          </div>
          <div className="grow max-w-sm">
            <Label htmlFor="shop-orders-search">Search</Label>
            <Input
              id="shop-orders-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Order ID or Stripe session"
              data-testid="shop-orders-search"
            />
          </div>
        </div>
      </Card>

      <Card>
        {list.isPending ? (
          <Spinner label="Loading orders…" />
        ) : list.isError ? (
          <ErrorPanel error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.orders.length === 0 ? (
          <p
            className="text-sm py-3"
            style={{ color: "hsl(var(--ink-3))" }}
            data-testid="shop-orders-empty"
          >
            {debounced || status
              ? "No orders match these filters."
              : "No storefront orders yet. Paid orders from the shop appear here."}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[680px]">
                <thead className="text-xs uppercase tracking-wider text-left text-slate-600">
                  <tr>
                    <th scope="col" className="px-2 py-2">
                      Order
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Customer
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Status
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Total
                    </th>
                    <th scope="col" className="px-2 py-2 text-right">
                      Items
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Placed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.orders.map((o) => (
                    <OrderRow
                      key={o.id}
                      order={o}
                      onOpen={() => setOpenOrderId(o.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={list.data.total}
              limit={LIMIT}
              offset={offset}
              onChange={setOffset}
              isLoading={list.isFetching}
            />
          </div>
        )}
      </Card>

      {openOrderId && (
        <OrderDetail
          orderId={openOrderId}
          onClose={() => setOpenOrderId(null)}
          onChanged={() => void list.refetch()}
        />
      )}
    </div>
  );
}

function OrderRow({
  order,
  onOpen,
}: {
  order: AdminShopOrderListItem;
  onOpen: () => void;
}) {
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="px-2 py-2">
        <button
          type="button"
          onClick={onOpen}
          className="font-mono text-xs underline decoration-dotted"
          style={{ color: "hsl(var(--penn-navy))" }}
          data-testid={`shop-order-open-${order.id}`}
        >
          {order.id.slice(0, 8)}
        </button>
      </td>
      <td className="px-2 py-2">
        {order.customerName ?? order.customerEmail ?? (
          <span className="text-slate-400">Guest</span>
        )}
      </td>
      <td className="px-2 py-2">
        <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {money(order.amountTotalCents)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{order.itemCount}</td>
      <td className="px-2 py-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        {formatAppDateTime(order.createdAt)}
      </td>
    </tr>
  );
}

function OrderDetail({
  orderId,
  onClose,
  onChanged,
}: {
  orderId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const detailKey = ["admin-shop-order", orderId] as const;
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => getShopOrder(orderId),
  });

  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [refundReason, setRefundReason] = useState("");

  const refetchAll = () => {
    void qc.invalidateQueries({ queryKey: detailKey });
    onChanged();
  };

  const trackMut = useMutation({
    mutationFn: () =>
      setShopOrderTracking(orderId, {
        carrier: carrier.trim(),
        number: tracking.trim(),
      }),
    onSuccess: refetchAll,
  });
  const deliverMut = useMutation({
    mutationFn: () => markShopOrderDelivered(orderId),
    onSuccess: refetchAll,
  });
  const refundMut = useMutation({
    mutationFn: () =>
      refundShopOrder(orderId, {
        reason: refundReason.trim() || undefined,
      }),
    onSuccess: refetchAll,
  });
  async function handleRefund() {
    // Money-moving + irreversible — confirm intent before issuing a real
    // Stripe refund (mirrors the returns page's refund guard).
    if (
      !(await confirm({
        title: "Refund this order?",
        description: `This issues a real Stripe refund of ${money(
          detail.data?.amountTotalCents,
        )} to the customer. This can't be undone.`,
        confirmLabel: "Refund order",
        destructive: true,
      }))
    )
      return;
    refundMut.mutate();
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">Order detail</h2>
        <Button intent="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      {detail.isPending ? (
        <Spinner label="Loading order…" />
      ) : detail.isError ? (
        <ErrorPanel
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <div className="space-y-4 mt-2">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge variant={statusVariant(detail.data.status)}>
              {detail.data.status}
            </Badge>
            <span className="font-mono text-xs text-slate-500">
              {detail.data.id}
            </span>
            <span className="font-medium">
              {detail.data.customerName ?? detail.data.customerEmail ?? "Guest"}
            </span>
            <span className="tabular-nums">
              {money(detail.data.amountTotalCents)}
            </span>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
              Line items
            </h3>
            <ul
              className="divide-y rounded-md border"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {detail.data.lineItems.length === 0 ? (
                <li className="px-3 py-2 text-sm text-slate-500">
                  No line items recorded.
                </li>
              ) : (
                detail.data.lineItems.map((li, i) => (
                  <li
                    key={i}
                    className="px-3 py-2 text-sm flex justify-between gap-3"
                  >
                    <span>
                      {li.quantity} × {li.name}
                    </span>
                    <span className="tabular-nums text-slate-500">
                      {money(li.amountSubtotalCents)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* Actions — the server enforces which statuses each is valid for
              and returns a 409 the mutation surfaces, so we keep the gating
              light here. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Tracking
              </h3>
              <Input
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="Carrier (e.g. UPS)"
                aria-label="Tracking carrier"
              />
              <Input
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="Tracking number"
                aria-label="Tracking number"
              />
              <Button
                intent="secondary"
                disabled={
                  !carrier.trim() || !tracking.trim() || trackMut.isPending
                }
                isLoading={trackMut.isPending}
                onClick={() => trackMut.mutate()}
              >
                Save tracking
              </Button>
              {trackMut.error instanceof Error && (
                <p className="text-xs text-rose-700">
                  {trackMut.error.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Fulfillment
              </h3>
              <Button
                intent="secondary"
                disabled={deliverMut.isPending}
                isLoading={deliverMut.isPending}
                onClick={() => deliverMut.mutate()}
              >
                Mark delivered
              </Button>
              {deliverMut.error instanceof Error && (
                <p className="text-xs text-rose-700">
                  {deliverMut.error.message}
                </p>
              )}

              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 pt-2">
                Refund
              </h3>
              {/* Stripe only accepts these three refund reasons; a
                  free-typed reason was rejected as invalid_body with no
                  refund issued. Empty = no reason recorded. */}
              <Select
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                aria-label="Refund reason"
                emptyOptionLabel="No reason"
                options={[
                  {
                    value: "requested_by_customer",
                    label: "Requested by customer",
                  },
                  { value: "duplicate", label: "Duplicate" },
                  { value: "fraudulent", label: "Fraudulent" },
                ]}
              />
              <Button
                intent="secondary"
                disabled={refundMut.isPending}
                isLoading={refundMut.isPending}
                onClick={() => void handleRefund()}
              >
                Refund order
              </Button>
              {refundMut.error instanceof Error && (
                <p className="text-xs text-rose-700">
                  {refundMut.error.message}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      {ConfirmDialogEl}
    </Card>
  );
}
