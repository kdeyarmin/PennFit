import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Truck,
  CalendarClock,
  ShoppingCart,
  CheckCircle2,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import {
  AccountApiError,
  fetchShopMeDashboard,
  type ShopMeDashboardResponse,
} from "@/lib/account-api";
import { SignedIn, useShopIdentity } from "@/lib/identity";
import { formatAppDate } from "@/lib/utils";

/**
 * Personalized banner rendered at the top of /home for signed-in
 * customers. Single round-trip to /shop/me/dashboard, which aggregates
 * the digest the patient most wants to see on a home visit:
 *
 *   * Next insurance resupply / shipment date.
 *   * Latest order tracking / delivery status.
 *   * Pending order backlog count.
 *   * Optional nudge toward insurance reorder when items are ready.
 *
 * Self-contained: <SignedIn> wraps it, so it returns nothing for
 * guests. Failures degrade silently — a network blip shouldn't
 * blank the home page.
 */
export function HomeStatusBanner() {
  return (
    <SignedIn fallback={null}>
      <SignedInBanner />
    </SignedIn>
  );
}

function SignedInBanner() {
  const { displayName } = useShopIdentity();
  const [data, setData] = useState<ShopMeDashboardResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await fetchShopMeDashboard();
        if (!cancelled) setData(d);
      } catch (err) {
        // 401 here means the session isn't yet hydrated on first paint;
        // any other error is a transient API blip. Either way, hide
        // the banner rather than rendering a broken state.
        if (!(err instanceof AccountApiError)) {
          console.warn("dashboard fetch failed", err);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded || !data) return null;

  // If absolutely nothing is going on (no subs, no orders, no cart,
  // no eligibility signal), skip rendering — a "you have no orders"
  // banner is just noise on home. We only show the banner when
  // there's signal worth hoisting above the marketing hero.
  const eligibleNowCount = data.eligibility?.eligibleNow?.length ?? 0;
  const hasSignal =
    data.nextShipment !== null ||
    data.latestOrder !== null ||
    eligibleNowCount > 0 ||
    (data.abandonedCart && data.abandonedCart.itemCount > 0);
  if (!hasSignal) return null;

  const firstName = ((displayName ?? "").trim().split(/\s+/)[0] ?? "").trim();
  const greeting = firstName ? `Welcome back, ${firstName}.` : "Welcome back.";

  return (
    <div
      className="w-full mb-10 animate-shimmer-in"
      data-testid="home-status-banner"
    >
      <div className="rounded-2xl border bg-gradient-to-br from-[hsl(var(--penn-navy)/0.06)] to-[hsl(var(--penn-gold)/0.07)] p-5 sm:p-6">
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                Your account
              </p>
              <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-[hsl(var(--penn-navy))] mt-1">
                {greeting}
              </h2>
            </div>
            <Link href="/account">
              <button
                type="button"
                className="text-sm font-medium text-[hsl(var(--penn-navy))] hover:underline inline-flex items-center gap-1"
                data-testid="home-banner-account-link"
              >
                Account <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </Link>
          </div>

          {data.eligibility && (
            <EligibilityBanner eligibility={data.eligibility} />
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.latestOrder && <OrderTile order={data.latestOrder} />}
            {data.nextShipment && <ShipmentTile shipment={data.nextShipment} />}
            {data.abandonedCart && <CartTile cart={data.abandonedCart} />}
          </div>

          {data.pendingOrders > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {data.pendingOrders > 0 && (
                <Link
                  href="/account/orders"
                  className="inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--penn-gold)/0.18)] px-3 py-1 text-xs font-medium text-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-gold)/0.28)]"
                >
                  <Truck className="w-3.5 h-3.5" />
                  {data.pendingOrders} order
                  {data.pendingOrders === 1 ? "" : "s"} awaiting shipment
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OrderTile({
  order,
}: {
  order: NonNullable<ShopMeDashboardResponse["latestOrder"]>;
}) {
  const delivered = !!order.deliveredAt;
  const shipped = !!order.shippedAt;
  const dateLabel = (iso: string | null) =>
    iso
      ? formatAppDate(iso, {
          month: "short",
          day: "numeric",
        })
      : null;

  let label: string;
  let detail: string;
  let Icon = Truck;
  if (delivered) {
    label = `Delivered ${dateLabel(order.deliveredAt) ?? ""}`.trim();
    detail = "Hope everything arrived in good shape.";
    Icon = CheckCircle2;
  } else if (shipped) {
    label = `Shipped ${dateLabel(order.shippedAt) ?? ""}`.trim();
    detail = order.trackingCarrier
      ? `${order.trackingCarrier} · ${order.trackingNumber}`
      : "Tracking on the way.";
  } else {
    label = "Order placed";
    detail = "We'll email you tracking when it ships.";
  }

  return (
    <Link href="/account/orders">
      <div className="rounded-xl border bg-background/70 p-4 hover:border-[hsl(var(--penn-gold))] transition-colors cursor-pointer h-full">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-gold)/0.18)] flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-[hsl(var(--penn-navy))]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
              {label}
            </p>
            <p className="text-xs text-muted-foreground truncate">{detail}</p>
          </div>
        </div>
      </div>
    </Link>
  );
}

function ShipmentTile({
  shipment,
}: {
  shipment: NonNullable<ShopMeDashboardResponse["nextShipment"]>;
}) {
  const dateLabel = formatAppDate(shipment.date, {
    month: "short",
    day: "numeric",
  });
  const itemLabel = shipment.firstItemName ?? "Resupply";
  const subtitle = shipment.cancelAtPeriodEnd
    ? "Final shipment in this cycle"
    : `Next: ${itemLabel}`;
  return (
    <Link href="/insurance">
      <div className="rounded-xl border bg-background/70 p-4 hover:border-[hsl(var(--penn-gold))] transition-colors cursor-pointer h-full">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center shrink-0">
            <CalendarClock className="w-4 h-4 text-[hsl(var(--penn-navy))]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
              Ships {dateLabel}
            </p>
            <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
          </div>
        </div>
      </div>
    </Link>
  );
}

/**
 * Phase A.1 — eligibility countdown / claim banner. Three states:
 *   1. eligibleNow.length > 0  → "N items ready to reorder now"
 *      with a CTA. This is the high-conversion S3-style nudge.
 *   2. soonest.daysUntil === 0 → "Eligible today" (subscription
 *      cycle rolled over today; stripe will dispatch shortly).
 *   3. soonest.daysUntil > 0   → "Your X is eligible in N days" so
 *      the patient gets the operational visibility without a CTA.
 *
 * Renders nothing when there's no eligibility signal at all.
 */
function EligibilityBanner({
  eligibility,
}: {
  eligibility: NonNullable<ShopMeDashboardResponse["eligibility"]>;
}) {
  const { eligibleNow, soonest } = eligibility;

  if (eligibleNow.length > 0) {
    const sample = eligibleNow[0]?.firstItemName;
    const headline =
      eligibleNow.length === 1
        ? `Your ${sample ?? "next supply"} is ready to reorder.`
        : `${eligibleNow.length} items are ready to reorder.`;
    return (
      <Link href="/account#autoship">
        <div
          className="rounded-xl border border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold)/0.10)] p-4 hover:bg-[hsl(var(--penn-gold)/0.16)] transition-colors cursor-pointer"
          data-testid="home-eligibility-banner-now"
        >
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-gold)/0.30)] flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-[hsl(var(--penn-navy))]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                {headline}
              </p>
              <p className="text-xs text-muted-foreground">
                Insurance covers most patients in full. Tap to review and ship.
              </p>
            </div>
            <ArrowRight className="w-4 h-4 text-[hsl(var(--penn-navy))] mt-2 shrink-0" />
          </div>
        </div>
      </Link>
    );
  }

  if (!soonest) return null;

  const itemLabel = soonest.firstItemName ?? "Your next supply";
  const headline =
    soonest.daysUntil === 0
      ? `${itemLabel} is eligible today.`
      : `${itemLabel} is eligible in ${soonest.daysUntil} day${soonest.daysUntil === 1 ? "" : "s"}.`;
  return (
    <div
      className="rounded-xl border bg-background/70 p-4"
      data-testid="home-eligibility-banner-countdown"
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center shrink-0">
          <CalendarClock className="w-4 h-4 text-[hsl(var(--penn-navy))]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
            {headline}
          </p>
          <p className="text-xs text-muted-foreground">
            We&apos;ll send a reminder when it&apos;s time to ship.
          </p>
        </div>
      </div>
    </div>
  );
}

function CartTile({
  cart,
}: {
  cart: NonNullable<ShopMeDashboardResponse["abandonedCart"]>;
}) {
  return (
    <Link href="/insurance">
      <div className="rounded-xl border bg-background/70 p-4 hover:border-[hsl(var(--penn-gold))] transition-colors cursor-pointer h-full">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-gold)/0.18)] flex items-center justify-center shrink-0">
            <ShoppingCart className="w-4 h-4 text-[hsl(var(--penn-navy))]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
              {cart.itemCount} supply item{cart.itemCount === 1 ? "" : "s"}{" "}
              ready to order
            </p>
            <p className="text-xs text-muted-foreground">
              Continue through insurance.
            </p>
          </div>
        </div>
      </div>
    </Link>
  );
}
