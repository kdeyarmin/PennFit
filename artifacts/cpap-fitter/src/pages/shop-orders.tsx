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
//   sign-in prompt that round-trips through ?redirect=/shop/orders
//   so they land back here after auth. The API endpoint itself
//   returns 401 if called without a session, so even a
//   curl-style probe doesn't leak.
//
// Pagination:
//   Cursor pagination via the API's composite `paidAt|id` cursor.
//   Newest first, single "Show more" button — no pre-fetch / no
//   infinite scroll because customers typically have <10 orders
//   and a single button is simpler to keyboard.

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Mail,
  MapPin,
  Package,
  Pencil,
  ShieldCheck,
  ShoppingBag,
  Truck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { toast } from "@/hooks/use-toast";
import {
  fetchMyOrders,
  formatMoneyCents,
  resendOrderReceipt,
  updateOrderShippingAddress,
  type OrderHistoryItem,
  type OrderShippingAddress,
} from "@/lib/shop-api";
import { SignedIn } from "@/lib/identity";
import { csrfHeader } from "@/lib/csrf";

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
      <SignedIn fallback={<SignedOutPrompt />}>
        <SignedInOrders />
      </SignedIn>
    </main>
  );
}

function SignedOutPrompt() {
  // We use ?redirect= (the convention the rest of the app uses —
  // see sign-in.tsx readRedirect()). An earlier version of this
  // page used ?redirect_url= which silently fell through to the
  // global fallback redirect after sign-in instead of returning
  // the customer to /shop/orders. Keep this in sync with every
  // other caller in the codebase: ?redirect=, never ?redirect_url=.
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
        Order history is tied to your PennPaps account so we can match it to
        your prescription on file.
      </p>
      <Link href="/sign-in?redirect=/shop/orders" className="inline-block mt-5">
        <Button>Sign in</Button>
      </Link>
    </div>
  );
}

/**
 * Render the signed-in user's order history UI, including loading, error,
 * empty, list and pagination states, and in-place updates after single-order edits.
 *
 * Handles the initial fetch of the first page of orders, a "Show more" flow
 * that appends additional pages (showing a destructive toast on failure), and
 * provides a `replaceOrder` callback used to update a single order without
 * reloading the list.
 *
 * @returns The component's JSX: either a loading skeleton, an error card, an
 * empty-state card, or the orders list with an optional "Show more orders" button.
 */
function SignedInOrders() {
  const [orders, setOrders] = useState<OrderHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // After a successful address edit we patch the order in place
  // rather than re-fetching the whole list — keeps the cursor stable
  // and avoids a flash of "Loading…". The PATCH is a single-order
  // operation so a list-wide refresh would be wasteful.
  const replaceOrder = useCallback((next: OrderHistoryItem) => {
    setOrders((prev) => prev.map((o) => (o.id === next.id ? next : o)));
  }, []);

  // Initial load. Run once on mount; the user-id-bound effect lives
  // inside the session so a fresh sign-in already remounts
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
      toast({
        variant: "destructive",
        title: "Couldn't load more orders",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  if (state === "loading") {
    return <OrdersSkeleton />;
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
        <h2 className="text-lg font-semibold tracking-tight">No orders yet</h2>
        <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto leading-relaxed">
          When you place an order in the shop, it shows up here so you can track
          shipping and re-order in one tap.
        </p>
        <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
          <Link href="/shop">
            <Button data-testid="orders-empty-shop-cta">Browse the shop</Button>
          </Link>
          <Link href="/consent">
            <Button variant="outline" data-testid="orders-empty-fitter-cta">
              Get a mask recommendation first
            </Button>
          </Link>
        </div>
        <p className="text-xs text-muted-foreground/80 mt-5 max-w-md mx-auto">
          Not sure which mask is right? Our 60-second fitter measures your face
          and recommends the top 3 — no card or ruler needed.
        </p>
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
          <OrderCard key={o.id} order={o} onOrderUpdated={replaceOrder} />
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

function OrderCard({
  order,
  onOrderUpdated,
}: {
  order: OrderHistoryItem;
  onOrderUpdated: (next: OrderHistoryItem) => void;
}) {
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
      <ShipmentSection order={order} onOrderUpdated={onOrderUpdated} />
      <ResendReceiptControl sessionId={order.sessionId} orderId={order.id} />
      <ReturnRequestControl order={order} />
    </li>
  );
}

// 60-day comfort-guarantee return initiation (Phase A.3, was 30 days
// pre-A.3). Only renders for orders paid within 60 days that don't
// already have an open return request.
// First click opens an inline form (reason picker + free-form note +
// preferred resolution); submit POSTs to /shop/me/orders/:sessionId/returns.
//
// We don't fetch the user's existing returns here for the disabled
// state — the server is the source of truth and will 409 with
// `open_return_exists` if a return is already in flight, surfacing
// the existing return ID so the user can navigate to it.
function ReturnRequestControl({ order }: { order: OrderHistoryItem }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("fit");
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState<"refund" | "exchange">(
    "exchange",
  );
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "success"; id: string }
    | { kind: "error"; message: string; existingId?: string }
    | null
  >(null);

  const paidAtMs = order.paidAt
    ? new Date(order.paidAt).getTime()
    : new Date(order.createdAt).getTime();
  const ageDays = (Date.now() - paidAtMs) / (1000 * 60 * 60 * 24);
  // Server is the source of truth on the 60-day window — we mirror it
  // client-side so the button doesn't render past the cutoff. Returns
  // outside the window can still be opened via support. Phase A.3 —
  // extended from 30 to 60 days to match the industry benchmark.
  const COMFORT_GUARANTEE_DAYS = 60;
  const eligible = ageDays <= COMFORT_GUARANTEE_DAYS;
  const daysLeft = Math.max(0, Math.ceil(COMFORT_GUARANTEE_DAYS - ageDays));

  if (!eligible && !result) return null;

  if (result?.kind === "success") {
    return (
      <div
        className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        data-testid={`order-${order.id}-return-success`}
      >
        Thanks — we&apos;ve received your return request. You&apos;ll get an
        email with next steps shortly.
      </div>
    );
  }

  async function handleSubmit() {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch(
        `/resupply-api/shop/me/orders/${encodeURIComponent(order.sessionId)}/returns`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({
            reason,
            reasonNote: note || null,
            preferredResolution: resolution,
          }),
        },
      );
      if (res.ok) {
        const json = (await res.json()) as { id: string };
        setResult({ kind: "success", id: json.id });
      } else {
        const json = (await res.json().catch(() => null)) as {
          error?: string;
          message?: string;
          returnId?: string;
        } | null;
        setResult({
          kind: "error",
          message:
            json?.message ??
            json?.error ??
            `Couldn't start the return (${res.status}).`,
          existingId: json?.returnId,
        });
      }
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-4 pt-3 border-t border-border/40">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs font-semibold text-[hsl(var(--penn-navy))] hover:underline"
          data-testid={`order-${order.id}-return-open`}
        >
          Need a swap or refund? Start a return
        </button>
        <p
          className="mt-1 text-[11px] text-muted-foreground"
          data-testid={`order-${order.id}-return-window`}
        >
          {daysLeft > 0
            ? `Covered by our 60-day comfort guarantee · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left to exchange.`
            : "Covered by our 60-day comfort guarantee."}
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-4 pt-4 border-t border-border/40 space-y-3"
      data-testid={`order-${order.id}-return-form`}
    >
      <div>
        <label
          className="text-xs font-semibold text-[hsl(var(--penn-navy))] block mb-1.5"
          htmlFor={`return-reason-${order.id}`}
        >
          What&apos;s the issue?
        </label>
        <select
          id={`return-reason-${order.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          data-testid={`order-${order.id}-return-reason`}
        >
          <option value="fit">It doesn&apos;t fit comfortably</option>
          <option value="defective">It arrived defective or damaged</option>
          <option value="wrong_item">I received the wrong item</option>
          <option value="no_longer_needed">I no longer need it</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label
          className="text-xs font-semibold text-[hsl(var(--penn-navy))] block mb-1.5"
          htmlFor={`return-resolution-${order.id}`}
        >
          What would you prefer?
        </label>
        <div
          className="grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label="Preferred resolution"
        >
          <button
            type="button"
            role="radio"
            aria-checked={resolution === "exchange"}
            onClick={() => setResolution("exchange")}
            className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
              resolution === "exchange"
                ? "border-[hsl(var(--penn-navy))] bg-[hsl(var(--penn-navy)/0.06)] text-[hsl(var(--penn-navy))]"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            Swap for a different size or style
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={resolution === "refund"}
            onClick={() => setResolution("refund")}
            className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
              resolution === "refund"
                ? "border-[hsl(var(--penn-navy))] bg-[hsl(var(--penn-navy)/0.06)] text-[hsl(var(--penn-navy))]"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            Refund
          </button>
        </div>
      </div>
      <div>
        <label
          className="text-xs font-semibold text-[hsl(var(--penn-navy))] block mb-1.5"
          htmlFor={`return-note-${order.id}`}
        >
          Anything we should know?{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <textarea
          id={`return-note-${order.id}`}
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 1000))}
          rows={3}
          maxLength={1000}
          placeholder="Tell us where it leaks, what doesn't fit, or what arrived wrong."
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          data-testid={`order-${order.id}-return-note`}
        />
        <div className="text-[10px] text-muted-foreground text-right mt-0.5">
          {note.length} / 1000
        </div>
      </div>
      {result?.kind === "error" && (
        <p className="text-xs text-rose-700" role="alert">
          {result.message}
        </p>
      )}
      <div className="flex gap-2 justify-end pt-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setResult(null);
          }}
          disabled={submitting}
          className="text-xs font-medium px-3 py-1.5 rounded-full text-muted-foreground hover:text-[hsl(var(--penn-navy))]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="text-xs font-semibold px-4 py-1.5 rounded-full bg-[hsl(var(--penn-navy))] text-white hover:bg-[hsl(var(--penn-navy))]/90 disabled:opacity-60"
          data-testid={`order-${order.id}-return-submit`}
        >
          {submitting ? "Submitting…" : "Submit return request"}
        </button>
      </div>
    </div>
  );
}

// Shipment + address block. Sits between the line items and the
// receipt control — visually ordered "what you bought → where it's
// going / where it is → secondary actions".
//
// Render rules:
//   - tracking present  → show carrier + number, with "Track" link
//                         when the server computed a URL.
//   - shipped, no track → "Shipped on <date>" label only.
//   - no shipment yet   → "Preparing your order" + (when canEditAddress)
//                         the "Edit address" button.
//   - delivered         → green badge on top of whatever else applies.
//
// We deliberately do NOT show a "still no tracking after N days"
// warning here — that's the support team's job. The customer-facing
// UI stays calm and factual.
function ShipmentSection({
  order,
  onOrderUpdated,
}: {
  order: OrderHistoryItem;
  onOrderUpdated: (next: OrderHistoryItem) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);

  // Pre-migration-0014 orders have neither shipping_address nor any
  // tracking columns. Skip the section entirely so they don't show
  // a misleading "Preparing your order" label that's actually just
  // "we never captured this data".
  const hasAnyShipmentData =
    order.shippingAddress !== null ||
    order.tracking !== null ||
    order.shippedAt !== null ||
    order.deliveredAt !== null;
  if (!hasAnyShipmentData) {
    return null;
  }

  const shippedDate = order.shippedAt
    ? new Date(order.shippedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const deliveredDate = order.deliveredAt
    ? new Date(order.deliveredAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div
      className="mt-4 pt-3 border-t border-border/40 space-y-3"
      data-testid={`order-${order.id}-shipment`}
    >
      {/* Tracking row */}
      <div className="flex flex-wrap items-start gap-3">
        <Truck className="w-4 h-4 mt-0.5 text-[hsl(var(--penn-navy))]/70 shrink-0" />
        <div className="flex-1 min-w-0">
          {order.tracking ? (
            <div className="text-sm">
              <div className="font-medium text-foreground">
                {order.tracking.carrier}
                <span className="text-muted-foreground font-mono ml-2">
                  {order.tracking.number}
                </span>
              </div>
              {order.tracking.url && (
                <a
                  href={order.tracking.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
                  data-testid={`order-${order.id}-track-link`}
                >
                  Track this shipment ↗
                </a>
              )}
              {shippedDate && (
                <div className="text-xs text-muted-foreground mt-1">
                  Shipped {shippedDate}
                </div>
              )}
            </div>
          ) : shippedDate ? (
            <div className="text-sm">
              <div className="font-medium text-foreground">Shipped</div>
              <div className="text-xs text-muted-foreground">
                Sent on {shippedDate}. Carrier tracking not provided.
              </div>
            </div>
          ) : (
            <div className="text-sm">
              <div className="font-medium text-foreground">
                Preparing your order
              </div>
              <div className="text-xs text-muted-foreground">
                We&apos;ll email you tracking when it ships.
              </div>
            </div>
          )}
        </div>
        {deliveredDate && (
          <Badge
            variant="outline"
            className="border-emerald-200 bg-emerald-50 text-emerald-700 font-semibold"
            data-testid={`order-${order.id}-delivered-badge`}
          >
            Delivered {deliveredDate}
          </Badge>
        )}
      </div>

      {order.podUploadedAt && (
        <PodPhotoSection orderId={order.id} sessionId={order.sessionId} />
      )}

      {/* Address row */}
      {order.shippingAddress && (
        <div className="flex flex-wrap items-start gap-3">
          <MapPin className="w-4 h-4 mt-0.5 text-[hsl(var(--penn-navy))]/70 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--penn-navy))]/70">
              Shipping to
            </div>
            <address
              className="not-italic text-sm text-foreground mt-1 leading-snug"
              data-testid={`order-${order.id}-address`}
            >
              {order.shippingAddress.line1}
              {order.shippingAddress.line2
                ? `, ${order.shippingAddress.line2}`
                : ""}
              <br />
              {order.shippingAddress.city}, {order.shippingAddress.state}{" "}
              {order.shippingAddress.postalCode}
            </address>
          </div>
          {order.canEditAddress && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
              data-testid={`order-${order.id}-edit-address`}
            >
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              Edit
            </Button>
          )}
        </div>
      )}

      {/* Address-edit dialog. Mounted here (not at the page root) so
          the dialog's local state is per-order: opening one card's
          dialog never leaks the prior card's draft. */}
      {order.shippingAddress && order.canEditAddress && (
        <EditAddressDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          orderId={order.id}
          current={order.shippingAddress}
          onSaved={(saved) => {
            onOrderUpdated({
              ...order,
              shippingAddress: saved.shippingAddress,
              shippedAt: saved.shippedAt,
              canEditAddress: saved.canEditAddress,
            });
            setEditOpen(false);
          }}
        />
      )}
    </div>
  );
}

// Address edit form. Lives in a modal so it can sit on top of the
// order-history list without taking the customer to a separate
// route — most edits are a one-line correction (typo in apartment
// number, wrong unit) that doesn't justify a navigation hop.
//
// US-only: the country field is fixed to "US". The PennPaps shop
// only ships domestically; international orders aren't supported and
// surface a server-side validation error if attempted via curl.
function EditAddressDialog({
  open,
  onOpenChange,
  orderId,
  current,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  current: OrderShippingAddress;
  onSaved: (next: {
    shippingAddress: OrderShippingAddress;
    shippedAt: string | null;
    canEditAddress: boolean;
  }) => void;
}) {
  const [line1, setLine1] = useState(current.line1);
  const [line2, setLine2] = useState(current.line2 ?? "");
  const [city, setCity] = useState(current.city);
  const [stateCode, setStateCode] = useState(current.state);
  const [postalCode, setPostalCode] = useState(current.postalCode);
  const [phase, setPhase] = useState<"idle" | "saving" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Reset the form when the dialog re-opens with a (potentially
  // different) `current` snapshot. Without this, editing one address,
  // closing without saving, and re-opening would show the stale
  // draft instead of the current saved value.
  useEffect(() => {
    if (!open) return;
    setLine1(current.line1);
    setLine2(current.line2 ?? "");
    setCity(current.city);
    setStateCode(current.state);
    setPostalCode(current.postalCode);
    setPhase("idle");
    setErrMsg(null);
  }, [open, current]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhase("saving");
    setErrMsg(null);
    try {
      const result = await updateOrderShippingAddress(orderId, {
        line1: line1.trim(),
        line2: line2.trim() ? line2.trim() : null,
        city: city.trim(),
        // The server uppercases this anyway — we trim+upper here so
        // the optimistic UI matches what the server will return.
        state: stateCode.trim().toUpperCase(),
        postalCode: postalCode.trim(),
        country: "US",
      });
      onSaved({
        shippingAddress: result.order.shippingAddress,
        shippedAt: result.order.shippedAt,
        canEditAddress: result.order.canEditAddress,
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unknown";
      setPhase("error");
      setErrMsg(addressErrorMessage(code));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid={`order-${orderId}-edit-address-dialog`}
      >
        <DialogHeader>
          <DialogTitle>Update shipping address</DialogTitle>
          <DialogDescription>
            You can change this until your order ships. After that, contact
            support to update the address of record.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`addr-line1-${orderId}`}>Street address</Label>
            <Input
              id={`addr-line1-${orderId}`}
              required
              maxLength={200}
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              data-testid={`order-${orderId}-addr-line1`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`addr-line2-${orderId}`}>
              Apartment, suite, etc. (optional)
            </Label>
            <Input
              id={`addr-line2-${orderId}`}
              maxLength={200}
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
              data-testid={`order-${orderId}-addr-line2`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor={`addr-city-${orderId}`}>City</Label>
              <Input
                id={`addr-city-${orderId}`}
                required
                maxLength={100}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                data-testid={`order-${orderId}-addr-city`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`addr-state-${orderId}`}>State</Label>
              <Input
                id={`addr-state-${orderId}`}
                required
                minLength={2}
                maxLength={2}
                value={stateCode}
                onChange={(e) => setStateCode(e.target.value)}
                placeholder="PA"
                className="uppercase"
                data-testid={`order-${orderId}-addr-state`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`addr-zip-${orderId}`}>ZIP code</Label>
              <Input
                id={`addr-zip-${orderId}`}
                required
                maxLength={20}
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                data-testid={`order-${orderId}-addr-zip`}
              />
            </div>
          </div>
          {phase === "error" && errMsg && (
            <div
              role="alert"
              className="text-xs text-rose-700 inline-flex items-center gap-1"
              data-testid={`order-${orderId}-addr-error`}
            >
              <AlertCircle className="w-3.5 h-3.5" />
              {errMsg}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={phase === "saving"}
              data-testid={`order-${orderId}-addr-cancel`}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={phase === "saving"}
              data-testid={`order-${orderId}-addr-save`}
            >
              {phase === "saving" && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Save address
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Map server-side error codes to short human-readable phrases.
// Mirror of the receipt-control mapper. We surface "already shipped"
// distinctly because the customer's next action genuinely changes —
// they need to contact support, not retry.
function addressErrorMessage(code: string): string {
  switch (code) {
    case "order_already_shipped":
      return "This order has already shipped. Contact support to update the address of record.";
    case "order_not_paid":
      return "This order isn't fully paid yet. Try again in a moment.";
    case "order_not_found":
      return "We couldn't find this order. Reload the page and try again.";
    case "invalid_body":
      return "Some fields look invalid. Double-check the address and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

// Re-send receipt control (C8). Lives BELOW the line items so the
// primary content (what you bought) is the visual emphasis and the
// secondary action ("email me again") is a quiet utility.
//
// State machine: idle → sending → (sent | error). After "sent",
// the button stays disabled for 30s with a confirmation pill so the
// customer can see the result without ambiguity. The 30s lockout
// also discourages accidental double-tap re-sends; the server still
// rate-limits to 5/10min as the hard ceiling.
function ResendReceiptControl({
  sessionId,
  orderId,
}: {
  sessionId: string;
  orderId: string;
}) {
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [info, setInfo] = useState<string | null>(null);

  // Auto-revert "sent" -> "idle" after 30s so the button becomes
  // tappable again without a page refresh (some customers will want
  // to re-send to a different inbox after fixing forwarding rules).
  useEffect(() => {
    if (phase !== "sent") return;
    const t = setTimeout(() => {
      setPhase("idle");
      setInfo(null);
    }, 30_000);
    return () => clearTimeout(t);
  }, [phase]);

  const onClick = async () => {
    setPhase("sending");
    setInfo(null);
    try {
      const result = await resendOrderReceipt(sessionId);
      setInfo(result.email);
      setPhase("sent");
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unknown";
      setInfo(messageForCode(code));
      setPhase("error");
    }
  };

  return (
    <div
      className="mt-4 pt-3 border-t border-border/40 flex flex-wrap items-center gap-3"
      data-testid={`order-${orderId}-receipt-controls`}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={phase === "sending" || phase === "sent"}
        data-testid={`order-${orderId}-resend-receipt`}
        aria-describedby={
          phase === "sent" || phase === "error"
            ? `order-${orderId}-resend-status`
            : undefined
        }
      >
        {phase === "sending" ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : phase === "sent" ? (
          <CheckCircle2 className="w-4 h-4 mr-2 text-emerald-600" />
        ) : (
          <Mail className="w-4 h-4 mr-2" />
        )}
        {phase === "sent" ? "Receipt sent" : "Email me the receipt"}
      </Button>
      {phase === "sent" && info && (
        <span
          id={`order-${orderId}-resend-status`}
          role="status"
          className="text-xs text-emerald-700 inline-flex items-center gap-1"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          Sent to {info}
        </span>
      )}
      {phase === "error" && info && (
        <span
          id={`order-${orderId}-resend-status`}
          role="alert"
          className="text-xs text-rose-700 inline-flex items-center gap-1"
        >
          <AlertCircle className="w-3.5 h-3.5" />
          {info}
        </span>
      )}
    </div>
  );
}

// Map the server's machine-readable error codes to short, customer-
// friendly phrases. We deliberately don't show "stripe_error" verbatim
// — non-technical customers find it confusing and it leaks our
// payment processor.
function messageForCode(code: string): string {
  switch (code) {
    case "rate_limited":
      return "Too many resend attempts. Try again in a few minutes.";
    case "not_payable":
      return "We couldn't find an email on file for this order. Contact support.";
    case "stripe_unavailable":
    case "stripe_error":
      return "Receipt service temporarily unavailable. Try again shortly.";
    case "not_found":
      return "Order not found.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/**
 * OrdersSkeleton — three order-card-shaped placeholders rendered
 * while the orders list is in flight. Replaces the previous
 * spinner-with-text loader so the layout below the header doesn't
 * look empty above the fold during the initial fetch.
 */
function OrdersSkeleton() {
  return (
    <div
      className="space-y-3"
      data-testid="orders-loading"
      role="status"
      aria-label="Loading your orders"
    >
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="rounded-2xl border border-border/60 bg-white p-4 md:p-5"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-3 w-3/4 mb-2" />
          <Skeleton className="h-3 w-1/2 mb-4" />
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading your orders…</span>
    </div>
  );
}

ShopOrders.displayName = "ShopOrders";

/**
 * Inline "View delivery photo" affordance. Renders a small disclosure
 * button that, when expanded, fetches the POD image bytes via
 * `GET /shop/orders/:sessionId/pod` and shows them inline. The
 * session id is the access grant (long opaque Stripe token); we
 * don't pre-fetch the bytes on render because not every patient
 * who lands on /shop/orders cares to look at every POD.
 */
function PodPhotoSection({
  orderId,
  sessionId,
}: {
  orderId: string;
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let revoked = false;
    let url: string | null = null;
    setError(null);
    void fetch(`/resupply-api/shop/orders/${encodeURIComponent(sessionId)}/pod`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Delivery photo is no longer available."
              : `Couldn't load delivery photo (${res.status}).`,
          );
        }
        return res.blob();
      })
      .then((blob) => {
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setImgUrl(url);
      })
      .catch((err) => {
        if (revoked) return;
        setError(err instanceof Error ? err.message : "Couldn't load photo.");
      });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
      setImgUrl(null);
    };
  }, [expanded, sessionId]);

  return (
    <div className="flex flex-col gap-2" data-testid={`order-${orderId}-pod`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1 self-start"
        data-testid={`order-${orderId}-pod-toggle`}
      >
        <ImageIcon className="w-3.5 h-3.5" />
        {expanded ? "Hide delivery photo" : "View delivery photo"}
      </button>
      {expanded && error && (
        <p
          className="text-xs text-destructive"
          data-testid={`order-${orderId}-pod-error`}
          role="alert"
        >
          {error}
        </p>
      )}
      {expanded && imgUrl && (
        <img
          src={imgUrl}
          alt="Delivery photo"
          className="max-w-sm max-h-72 rounded-md border border-border/60"
          data-testid={`order-${orderId}-pod-img`}
        />
      )}
    </div>
  );
}
