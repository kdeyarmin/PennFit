// /account → "Recent orders" section.
//
// Lists the patient's recent paid orders with one-tap "Buy this
// again" reorder + a "Report not received" inline form. Reorder
// hydrates the cart from the stored Stripe line items and drops a
// sessionStorage breadcrumb so /shop/cart can render the
// "Loaded from your order on …" banner.

import { useState } from "react";
import { Link, useLocation } from "wouter";

import { Loader2, RefreshCw, ShoppingBag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCart, type CartItem } from "@/hooks/use-cart";
import { AccountApiError, type ShopRecentOrder } from "@/lib/account-api";
import { fetchOrderSummary, formatMoneyCents } from "@/lib/shop-api";

// sessionStorage breadcrumb shape. /shop/cart reads this once on
// mount, renders the "Loaded from your order on …" banner, then
// clears it. Stored as JSON so we can extend later (e.g. orderId)
// without bumping the storage key.
const REORDER_FROM_KEY = "pennpaps_reorder_from";

export function OrdersSection({
  orders,
  previewMode,
}: {
  orders: ShopRecentOrder[];
  previewMode: boolean;
}) {
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const { replaceItems } = useCart();
  const [, navigate] = useLocation();

  async function handleBuyAgain(order: ShopRecentOrder) {
    // Preview mode: /shop/orders/:sessionId would 503 (no Stripe).
    // The button is also visually disabled in this branch, but guard
    // here too in case of a stale click.
    if (previewMode) return;
    setReorderError(null);
    setReorderingId(order.sessionId);
    try {
      const summary = await fetchOrderSummary(order.sessionId);
      // Filter line items down to ones we can actually put back in
      // the cart. A null priceId or unitAmountCents means the item
      // can't round-trip through /shop/checkout (which validates by
      // priceId), so silently dropping it is the safest default.
      const reorderable: CartItem[] = summary.lineItems
        .filter(
          (
            li,
          ): li is typeof li & { priceId: string; unitAmountCents: number } =>
            !!li.priceId && typeof li.unitAmountCents === "number",
        )
        .map((li) => ({
          productId: li.productId ?? li.priceId,
          priceId: li.priceId,
          name: li.name,
          unitAmountCents: li.unitAmountCents,
          // Reorders always go back as one-time. If the patient
          // wants auto-ship for a reordered SKU they can toggle it
          // on the cart row before paying — we never silently
          // promote a one-time receipt into a subscription.
          mode: "one_time" as const,
          recurringPriceId: null,
          recurringIntervalLabel: null,
          currency: summary.currency ?? "usd",
          quantity: li.quantity,
          imageUrl: li.imageUrl,
          // No reliable way to know from a Stripe line item if it was
          // a curated bundle vs an individual product. Default to
          // false; the cart UI handles both shapes the same way.
          isBundle: false,
          // Stripe line items don't carry our inventory metadata.
          // Same convention as cart-resume + localStorage hydrate:
          // null = "not tracked here, the live product fetch +
          // checkout validation will catch out-of-stock before pay."
          stockCount: null,
        }));

      if (reorderable.length === 0) {
        setReorderError(
          "We couldn't load this order back into your cart. Try browsing the shop instead.",
        );
        setReorderingId(null);
        return;
      }

      // Track partial-reorder cases so the cart banner can be honest
      // about what got dropped. The most common cause is a price
      // that's since been archived in Stripe — checkout would have
      // rejected it anyway, but failing here (with a count) instead
      // of at the payment step is meaningfully friendlier UX.
      const droppedCount = summary.lineItems.length - reorderable.length;

      replaceItems(reorderable);

      // Drop a sessionStorage breadcrumb so /shop/cart can render the
      // "Loaded from your order on …" banner. sessionStorage (not
      // localStorage) means the flag dies when the tab closes, so a
      // user who reorders, closes the tab, then revisits the cart
      // doesn't see a stale banner. Stored as JSON so we can extend
      // the payload later (e.g. orderId) without a key bump.
      try {
        window.sessionStorage.setItem(
          REORDER_FROM_KEY,
          JSON.stringify({
            sessionId: order.sessionId,
            createdAt: order.createdAt,
            droppedCount,
          }),
        );
      } catch {
        // Quota exceeded / private mode — banner won't show, cart
        // still works. Not worth surfacing to the user.
      }

      navigate("/shop/cart");
    } catch (err) {
      const msg =
        err instanceof AccountApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setReorderError(msg);
      setReorderingId(null);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-orders-section"
    >
      <div className="flex items-center gap-2 mb-4">
        <ShoppingBag className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Recent orders</h2>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No orders yet. Your first purchase will show up here for one-tap
          reorders.
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {orders.map((o) => (
            <li
              key={o.id}
              className="py-3 flex items-center justify-between gap-3"
              data-testid={`account-order-${o.sessionId}`}
            >
              <div className="min-w-0">
                <p className="font-medium tabular-nums">
                  {o.amountTotalCents
                    ? formatMoneyCents(o.amountTotalCents, o.currency ?? "usd")
                    : "—"}{" "}
                  <span className="ml-2 text-xs uppercase tracking-wide text-muted-foreground">
                    {o.status}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(o.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/shop/checkout-success?session_id=${encodeURIComponent(o.sessionId)}`}
                  className="text-xs text-muted-foreground hover:text-primary"
                >
                  Details
                </Link>
                {o.status === "paid" && <ReportLostLink orderId={o.id} />}
                {o.status === "paid" && (
                  <Button
                    size="sm"
                    disabled={previewMode || reorderingId === o.sessionId}
                    onClick={() => void handleBuyAgain(o)}
                    data-testid={`account-reorder-${o.sessionId}`}
                    title={
                      previewMode
                        ? "Reordering will enable as soon as Stripe is connected."
                        : undefined
                    }
                  >
                    {reorderingId === o.sessionId ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                        Buy this again
                      </>
                    )}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {reorderError && (
        <p
          className="mt-3 text-sm text-destructive"
          data-testid="account-reorder-error"
          role="alert"
        >
          {reorderError}
        </p>
      )}
    </section>
  );
}

function ReportLostLink({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    { kind: "ok" } | { kind: "error"; message: string } | null
  >(null);
  async function submit() {
    setSubmitting(true);
    setResult(null);
    try {
      const { reportLostShipment } =
        await import("@/lib/account/self-service-api");
      await reportLostShipment(orderId, note.trim());
      setResult({ kind: "ok" });
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }
  if (result?.kind === "ok") {
    return (
      <span className="text-xs text-emerald-700">
        Reported — we&apos;ll follow up
      </span>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-destructive underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        Report not received
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        placeholder="Describe what happened (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="h-7 rounded border px-2 text-xs w-56"
      />
      <Button size="sm" onClick={() => void submit()} disabled={submitting}>
        {submitting ? "…" : "Report"}
      </Button>
      <button
        type="button"
        className="text-xs text-muted-foreground"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
      {result?.kind === "error" && (
        <span className="text-xs text-destructive ml-1">{result.message}</span>
      )}
    </div>
  );
}
