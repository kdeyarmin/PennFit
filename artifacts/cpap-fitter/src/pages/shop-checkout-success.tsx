// /shop/checkout-success — Stripe redirects here after successful
// payment. Reads `session_id` from the query string and fetches the
// order summary from /resupply-api/shop/orders/:sessionId.
//
// Cart-clearing: we clear the cart here (not on checkout-click) so
// that closing the Stripe tab keeps the cart intact, but a confirmed
// landing on /shop/checkout-success means the order is fully placed
// and the cart is no longer relevant.

import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  MapPin,
  PackageCheck,
  CalendarClock,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCart } from "@/hooks/use-cart";
import { SubscribeRemindersCta } from "@/components/subscribe-reminders-cta";
import { ComfortGuarantee } from "@/components/comfort-guarantee";
import {
  fetchOrderSummary,
  formatMoneyCents,
  type OrderSummaryResponse,
} from "@/lib/shop-api";
import {
  MAX_PENDING_POLLS,
  PENDING_POLL_INTERVAL_MS,
  shouldPollPendingPayment,
} from "@/lib/checkout-pending-poll";
import { track } from "@/lib/track";

function getSessionIdFromQuery(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("session_id");
}

// Per-Stripe-session "already finalized" marker. Lives in localStorage
// (like the cart it protects) so it survives new tabs — the success URL
// gets revisited via the back button, browser history, and the receipt
// email, sometimes days later. Values are epoch-ms timestamps so stale
// markers can be pruned.
const FINALIZED_KEY_PREFIX = "pennpaps_checkout_finalized_v1:";
const FINALIZED_MARKER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function wasFinalized(sessionId: string): boolean {
  try {
    return (
      window.localStorage.getItem(FINALIZED_KEY_PREFIX + sessionId) !== null
    );
  } catch {
    return false;
  }
}

function markFinalized(sessionId: string): void {
  try {
    const now = Date.now();
    window.localStorage.setItem(FINALIZED_KEY_PREFIX + sessionId, String(now));
    // Prune markers older than the TTL so the namespace stays bounded.
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(FINALIZED_KEY_PREFIX)) continue;
      const stamp = Number(window.localStorage.getItem(key));
      if (!Number.isFinite(stamp) || now - stamp > FINALIZED_MARKER_TTL_MS) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Private-mode/storage failure — worst case we re-finalize on a
    // revisit, which is the pre-marker behavior.
  }
}

export function ShopCheckoutSuccess() {
  useDocumentTitle("Order confirmed");
  const sessionId = getSessionIdFromQuery();
  const { clear } = useCart();
  const [order, setOrder] = useState<OrderSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pollCount, setPollCount] = useState(0);

  // Fire the conversion event + clear the cart exactly once per Stripe
  // session — when (and only when) Stripe reports the session PAID.
  // "Once" must hold across MOUNTS, not just within one: this page is
  // re-entered via back button / history / the receipt email, and
  // re-running here would wipe whatever NEW cart the customer has built
  // since the order (and double-count the conversion). The localStorage
  // marker is what carries that guarantee across visits; within a visit
  // the pending re-poll stops the moment the status flips to paid.
  const finalizeIfPaid = React.useCallback(
    (o: OrderSummaryResponse) => {
      if (o.paymentStatus !== "paid") return;
      if (sessionId && wasFinalized(sessionId)) return;
      track("checkout_completed", {
        lineItems: o.lineItems.length,
        amountTotalCents: o.amountTotalCents,
        currency: o.currency,
      });
      clear();
      if (sessionId) markFinalized(sessionId);
    },
    [clear, sessionId],
  );

  useEffect(() => {
    if (!sessionId) {
      setError("No order reference found in the URL.");
      setLoading(false);
      return;
    }
    let active = true;
    // Race the fetch against a hard timeout so a hung network doesn't
    // strand the patient on "Confirming your order…" indefinitely.
    // 10s is comfortably above p99 webhook propagation; on timeout
    // the user gets an actionable error instead of an infinite spinner.
    // We hold the timer id so we can cancel it when the fetch
    // resolves first (or on unmount); otherwise it would fire after
    // the success path and uselessly reject a Promise nobody is
    // awaiting anymore.
    const FETCH_TIMEOUT_MS = 10_000;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(
              "Confirmation is taking longer than expected. Refresh in a moment to retry.",
            ),
          ),
        FETCH_TIMEOUT_MS,
      );
    });
    Promise.race([fetchOrderSummary(sessionId), timeoutPromise])
      .then((o) => {
        if (!active) return;
        setOrder(o);
        // Clear the cart only after we've confirmed Stripe marked
        // the session as PAID. Webhook lag can leave us briefly in
        // a "session exists, payment pending" state — keeping the
        // cart intact across that window means a user who hits
        // refresh too early doesn't lose their items if payment
        // ultimately fails. The bounded poll below re-checks that
        // window so the page settles itself instead of stranding the
        // customer on a "refresh to see if you were charged" screen.
        finalizeIfPaid(o);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
    // We only want this to run on mount with the captured sessionId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Bounded self-refresh while Stripe's webhook is still settling the
  // charge. The order can read back as not-yet-paid for a few seconds
  // after the customer lands here; rather than ask them to manually
  // refresh a payment page (anxiety-inducing — "was I charged?"), we
  // re-fetch a handful of times so the status flips to "paid" on its
  // own. Stops as soon as it's paid or the attempt cap is hit.
  useEffect(() => {
    if (
      !sessionId ||
      !shouldPollPendingPayment({
        loading,
        hasOrder: order != null,
        paymentStatus: order?.paymentStatus,
        pollCount,
      })
    ) {
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      fetchOrderSummary(sessionId)
        .then((o) => {
          if (!active) return;
          setOrder(o);
          finalizeIfPaid(o);
        })
        .catch(() => {
          // Transient read failure — the next tick (or a manual
          // refresh) can still recover; don't replace the pending
          // copy with a hard error.
        })
        .finally(() => {
          if (active) setPollCount((n) => n + 1);
        });
    }, PENDING_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, loading, order, pollCount]);

  const isPaid = order?.paymentStatus === "paid";

  return (
    <div className="container mx-auto px-4 md:px-6 py-12 md:py-16 max-w-2xl">
      {loading ? (
        <div
          className="glass-card rounded-2xl p-12 text-center text-muted-foreground"
          data-testid="success-loading"
        >
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
          Confirming your order…
        </div>
      ) : error ? (
        <div
          className="glass-card rounded-2xl p-10 text-center"
          data-testid="success-error"
        >
          <h2 className="text-xl font-semibold tracking-tight mb-2">
            We couldn&apos;t find that order.
          </h2>
          <p className="text-sm text-muted-foreground mb-6">{error}</p>
          <Link href="/shop">
            <Button>
              Back to the shop <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </Link>
        </div>
      ) : order ? (
        <div
          className="glass-card rounded-2xl p-8 md:p-10"
          data-testid="success-card"
        >
          <div className="flex justify-center mb-5">
            <div className="h-14 w-14 rounded-2xl icon-halo-gold flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7" />
            </div>
          </div>
          <h1 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-center mb-3">
            {isPaid
              ? "Thanks — your order is in."
              : "We're confirming your payment…"}
          </h1>
          {isPaid ? (
            <p
              className="text-center text-muted-foreground mb-8 leading-relaxed"
              data-testid="success-paid-copy"
            >
              We charged your card{" "}
              <span className="font-semibold text-foreground">
                {order.amountTotalCents != null && order.currency
                  ? formatMoneyCents(order.amountTotalCents, order.currency)
                  : "your card"}
              </span>{" "}
              and we&apos;re packing it now. You&apos;ll get a shipping
              confirmation by email when it leaves the warehouse.
            </p>
          ) : (
            <p
              className="text-center text-muted-foreground mb-8 leading-relaxed"
              data-testid="success-pending-copy"
            >
              Your payment is finishing up.{" "}
              {pollCount < MAX_PENDING_POLLS
                ? "This page updates on its own the moment it settles — no need to refresh."
                : "This is taking a little longer than usual — check the receipt email Stripe sent, or refresh this page in a moment."}{" "}
              If the charge doesn&apos;t go through, your cart is still saved.
            </p>
          )}

          <div className="border-t border-border/40 pt-6">
            <h2 className="font-semibold tracking-tight mb-3 flex items-center gap-2">
              <PackageCheck className="w-4 h-4 text-muted-foreground" />
              What&apos;s shipping
            </h2>
            <ul className="space-y-2 text-sm">
              {order.lineItems.map((li, i) => (
                <li
                  key={i}
                  className="flex justify-between gap-3"
                  data-testid={`success-line-${i}`}
                >
                  <span>
                    {li.quantity} × {li.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {li.amountSubtotalCents != null && order.currency
                      ? formatMoneyCents(li.amountSubtotalCents, order.currency)
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {(order.shippingCity || order.shippingState) && (
            <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="w-4 h-4" />
              Shipping to {order.shippingCity}
              {order.shippingCity && order.shippingState ? ", " : ""}
              {order.shippingState}
            </div>
          )}

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link href="/learn/replacement-schedule">
              <Button
                variant="outline"
                className="w-full"
                data-testid="success-schedule-cta"
              >
                <CalendarClock className="w-4 h-4 mr-2" />
                See replacement schedule
              </Button>
            </Link>
            <Link href="/shop">
              <Button className="w-full" data-testid="success-shop-cta">
                Back to shop <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>

          {/* Post-purchase reminders nudge — they just bought supplies, so
              this is the perfect moment to ask them to enroll. */}
          <div className="mt-6 space-y-4">
            <SubscribeRemindersCta variant="compact" />
            <ComfortGuarantee variant="callout" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
