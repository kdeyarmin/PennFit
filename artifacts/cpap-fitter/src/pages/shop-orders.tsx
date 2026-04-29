// /shop/orders — order history for signed-in customers.
//
// Why this page exists separately from /account:
//   /account is the patient-portal landing page (insurance,
//   prescriptions, mask fitter results). The shop is a distinct
//   purchase surface — keeping order history under the /shop
//   path keeps the cash-pay flow self-contained and lets us link
//   "Your orders" right next to the cart icon in the header.
//
// Auth model:
//   The page is gated client-side: signed-out visitors see a
//   sign-in prompt with a redirect_url back to this page. The API
//   endpoint itself returns 401 if called without a Clerk session,
//   so even a curl-style probe doesn't leak.
//
// Pagination:
//   Cursor pagination via the API's composite `paidAt|id` cursor.
//   Newest first, single "Show more" button — no pre-fetch / no
//   infinite scroll because customers typically have <10 orders
//   and a single button is simpler to keyboard.

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Show } from "@clerk/react";
import { Loader2, Package, ShieldCheck, ShoppingBag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  fetchMyOrders,
  formatMoneyCents,
  type OrderHistoryItem,
} from "@/lib/shop-api";

type LoadState = "idle" | "loading" | "ready" | "error";

export function ShopOrders() {
  // Set the tab title for everyone (signed-in or out) — running it
  // here in the top-level component is the simplest way to keep the
  // browser tab consistent with the visible heading without an
  // extra wrapper layer.
  useDocumentTitle(
    "Your orders — PennPaps shop",
    "Your past PennPaps shop orders.",
  );
  // App.tsx already wraps every route in <Layout>, so this page
  // returns ONLY its content — wrapping in <Layout> here would
  // double-render the global header.
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="container mx-auto max-w-3xl px-4 md:px-6 py-10 md:py-14"
    >
      <header className="mb-8">
        <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight">
          Your orders
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          Past purchases from the PennPaps cash-pay shop.
        </p>
      </header>
      <Show
        when="signed-in"
        fallback={<SignedOutPrompt />}
      >
        <SignedInOrders />
      </Show>
    </main>
  );
}

function SignedOutPrompt() {
  // We use ?redirect_url so Clerk's sign-in page sends them back here
  // after a successful sign-in. Same param name our other shop links
  // use (matches the cart prompt) for muscle-memory consistency.
  return (
    <div
      className="glass-card rounded-2xl p-8 text-center"
      data-testid="orders-signin-prompt"
    >
      <ShoppingBag className="w-10 h-10 text-[hsl(var(--penn-navy))]/60 mx-auto mb-3" />
      <h2 className="text-lg font-semibold tracking-tight">
        Sign in to view your orders
      </h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
        Order history is tied to your PennPaps account so we can match it
        to your prescription on file.
      </p>
      <Link href="/sign-in?redirect_url=/shop/orders" className="inline-block mt-5">
        <Button>Sign in</Button>
      </Link>
    </div>
  );
}

function SignedInOrders() {
  const [orders, setOrders] = useState<OrderHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Initial load. Run once on mount; the user-id-bound effect lives
  // inside the Clerk session so a fresh sign-in already remounts
  // this component with a fresh component state.
  useEffect(() => {
    let active = true;
    setState("loading");
    setErrMsg(null);
    fetchMyOrders({ limit: 10 })
      .then((page) => {
        if (!active) return;
        setOrders(page.orders);
        setCursor(page.nextCursor);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState("error");
        setErrMsg(
          err instanceof Error ? err.message : "Couldn't load your orders.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const onLoadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchMyOrders({ cursor, limit: 10 });
      setOrders((prev) => [...prev, ...page.orders]);
      setCursor(page.nextCursor);
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Couldn't load more orders.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  if (state === "loading") {
    return (
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center"
        data-testid="orders-loading"
      >
        <Loader2 className="w-4 h-4 animate-spin" /> Loading your orders…
      </div>
    );
  }

  if (state === "error") {
    return (
      <div
        className="glass-card rounded-2xl p-6 border-l-4 border-l-rose-500"
        data-testid="orders-error"
      >
        <h2 className="font-semibold tracking-tight">
          We couldn&apos;t load your orders.
        </h2>
        <p className="text-sm text-muted-foreground mt-2">
          {errMsg ?? "Please try again in a moment."}
        </p>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div
        className="glass-card rounded-2xl p-8 text-center"
        data-testid="orders-empty"
      >
        <Package className="w-10 h-10 text-[hsl(var(--penn-navy))]/60 mx-auto mb-3" />
        <h2 className="text-lg font-semibold tracking-tight">
          No orders yet
        </h2>
        <p className="text-sm text-muted-foreground mt-2">
          When you place an order in the shop, it will appear here.
        </p>
        <Link href="/shop" className="inline-block mt-5">
          <Button variant="outline">Browse the shop</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div
        className="rounded-xl border border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/5 px-4 py-3 flex items-start gap-3 text-xs text-[hsl(var(--penn-navy))]/80"
        data-testid="orders-verified-note"
      >
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--penn-gold))]" />
        <p>
          Reviews you write on these products will be marked{" "}
          <span className="font-semibold">Verified purchaser</span>.
        </p>
      </div>
      <ul className="space-y-4" data-testid="orders-list">
        {orders.map((o) => (
          <OrderCard key={o.id} order={o} />
        ))}
      </ul>
      {cursor && (
        <div className="text-center pt-4">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="orders-load-more"
          >
            {loadingMore ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Show more orders
          </Button>
        </div>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: OrderHistoryItem }) {
  const paidAt = order.paidAt ?? order.createdAt;
  const dateLabel = new Date(paidAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <li
      className="glass-card rounded-2xl p-5 md:p-6"
      data-testid={`order-${order.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border/40 pb-3">
        <div>
          <div className="text-xs uppercase font-semibold tracking-wider text-[hsl(var(--penn-navy))]/70">
            Paid {dateLabel}
          </div>
          <div className="text-xs text-muted-foreground mt-1 font-mono">
            {order.sessionId.slice(-12)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge
            variant="outline"
            className="border-emerald-200 bg-emerald-50 text-emerald-700 font-semibold"
          >
            Paid
          </Badge>
          {order.amountTotalCents !== null && (
            <div
              className="text-lg font-bold tracking-tight text-[hsl(var(--penn-navy))]"
              data-testid={`order-${order.id}-total`}
            >
              {formatMoneyCents(
                order.amountTotalCents,
                order.currency ?? "usd",
              )}
            </div>
          )}
        </div>
      </div>
      <ul className="mt-3 space-y-2" data-testid={`order-${order.id}-items`}>
        {order.items.map((it) => (
          <li
            key={`${it.productId}|${it.unitAmountCents ?? "x"}`}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <div className="min-w-0">
              <Link
                href={`/shop/p/${encodeURIComponent(it.productId)}`}
                className="font-medium text-foreground hover:text-primary transition-colors truncate inline-block max-w-full"
              >
                {it.productName}
              </Link>
              <span className="text-muted-foreground ml-2 tabular-nums">
                × {it.quantity}
              </span>
            </div>
            {it.unitAmountCents !== null && (
              <span className="text-muted-foreground tabular-nums shrink-0">
                {formatMoneyCents(
                  it.unitAmountCents * it.quantity,
                  it.currency ?? order.currency ?? "usd",
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

ShopOrders.displayName = "ShopOrders";
