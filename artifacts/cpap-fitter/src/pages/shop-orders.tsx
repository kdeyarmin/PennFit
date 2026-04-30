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
//   returns 401 if called without a Clerk session, so even a
//   curl-style probe doesn't leak.
//
// Pagination:
//   Cursor pagination via the API's composite `paidAt|id` cursor.
//   Newest first, single "Show more" button — no pre-fetch / no
//   infinite scroll because customers typically have <10 orders
//   and a single button is simpler to keyboard.

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Show } from "@clerk/react";
import {
  AlertCircle,
  CheckCircle2,
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
import {
  fetchMyOrders,
  formatMoneyCents,
  resendOrderReceipt,
  updateOrderShippingAddress,
  type OrderHistoryItem,
  type OrderShippingAddress,
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
        Order history is tied to your PennPaps account so we can match it
        to your prescription on file.
      </p>
      <Link href="/sign-in?redirect=/shop/orders" className="inline-block mt-5">
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

  // After a successful address edit we patch the order in place
  // rather than re-fetching the whole list — keeps the cursor stable
  // and avoids a flash of "Loading…". The PATCH is a single-order
  // operation so a list-wide refresh would be wasteful.
  const replaceOrder = useCallback((next: OrderHistoryItem) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === next.id ? next : o)),
    );
  }, []);

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
        <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto leading-relaxed">
          When you place an order in the shop, it shows up here so you
          can track shipping and re-order in one tap.
        </p>
        <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
          <Link href="/shop">
            <Button data-testid="orders-empty-shop-cta">
              Browse the shop
            </Button>
          </Link>
          <Link href="/">
            <Button
              variant="outline"
              data-testid="orders-empty-fitter-cta"
            >
              Get a mask recommendation first
            </Button>
          </Link>
        </div>
        <p className="text-xs text-muted-foreground/80 mt-5 max-w-md mx-auto">
          Not sure which mask is right? Our 60-second fitter measures
          your face and recommends the top 3 — no card or ruler needed.
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
    </li>
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
              {order.shippingAddress.line2 ? `, ${order.shippingAddress.line2}` : ""}
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

ShopOrders.displayName = "ShopOrders";
