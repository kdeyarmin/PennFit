// /account — patient self-service account page.
//
//   * Profile (name + shipping address) — editable inline. Persists
//     to /shop/me PUT. Works in preview mode (no Stripe needed).
//   * Saved card — read-only display ("Visa •••• 4242"). Update CTA
//     starts a $0 setup-intent-style flow via /shop/me/quick-checkout
//     with a placeholder $0 cart… not yet — for v1 we send the user
//     into the standard checkout to update card on next purchase.
//     We surface the message instead of pretending an "Update card"
//     button works in isolation.
//   * Order history — last N orders with "Buy this again" buttons.
//     The button fetches the past order's line items via
//     /shop/orders/:sessionId, drops them into the local cart with
//     useCart().replaceItems, and navigates to /shop/cart so the
//     customer can review (and adjust) before paying. The cart page
//     reads a `pennpaps_reorder_from` sessionStorage flag to render
//     a "Loaded from your order on …" banner. We deliberately do
//     NOT bounce straight to Stripe — older patients want to see
//     what they're buying before a card form appears.
//
// Auth gating: rendered behind <SignedIn>. Wouter-level redirect to
// /sign-in?redirect=/account when not signed in.

import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Show, useUser } from "@clerk/react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  Loader2,
  MapPin,
  Package,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Settings2,
  ShoppingBag,
  User as UserIcon,
  UserCircle2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  AccountApiError,
  cancelShopSubscription,
  changeShopSubscriptionCadence,
  fetchShopCadenceOptions,
  fetchShopMe,
  fetchShopMySubscriptions,
  pauseShopSubscription,
  resumeShopSubscription,
  updateShopMe,
  type SavedShippingAddress,
  type ShopCadenceOption,
  type ShopMeResponse,
  type ShopRecentOrder,
  type ShopSubscriptionView,
  type SavedCard,
} from "@/lib/account-api";
import {
  fetchOrderSummary,
  fetchShopProducts,
  formatMoneyCents,
} from "@/lib/shop-api";
import { useCart, type CartItem } from "@/hooks/use-cart";
import { CommPrefsSection } from "@/components/comm-prefs-section";
import { ReorderSuggestionsSection } from "@/components/reorder-suggestions-section";

// sessionStorage key picked up by /shop/cart to render the "Loaded
// from your order on …" banner. Stored as a JSON object so we can
// extend it later (e.g. orderId) without a schema bump.
const REORDER_FROM_KEY = "pennpaps_reorder_from";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function AccountPage() {
  useDocumentTitle("My account");
  // We render an inline sign-in prompt for signed-out visitors instead
  // of <Redirect to="/sign-in?…">. Wouter's <Redirect> wrapped inside
  // Clerk's <Show fallback> renders during the brief Clerk-boot window
  // and then again on the signed-out branch; the double-mount caused
  // the page to render blank instead of navigating. Mirroring the
  // /shop/orders pattern (inline CTA + ?redirect=/account round-trip)
  // is more graceful UX anyway — the customer sees *why* they're being
  // asked to sign in instead of a jarring auto-bounce.
  return (
    <Show when="signed-in" fallback={<SignedOutAccountPrompt />}>
      <AccountInner />
    </Show>
  );
}

function SignedOutAccountPrompt() {
  // Keep the ?redirect= convention in sync with sign-in.tsx
  // readRedirect() — it reads ONLY ?redirect=, NOT ?redirect_url=.
  return (
    <div className="container mx-auto px-4 md:px-6 py-12 md:py-20 max-w-2xl">
      <div
        className="glass-card rounded-2xl p-8 md:p-10 text-center"
        data-testid="account-signin-prompt"
      >
        <UserCircle2 className="w-12 h-12 text-[hsl(var(--penn-navy))]/60 mx-auto mb-4" />
        <h1 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-2">
          Sign in to your account
        </h1>
        <p className="text-sm md:text-base text-muted-foreground max-w-md mx-auto mb-6">
          Your saved shipping address, card on file, and order history live
          here. Sign in or create an account to continue.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/sign-in?redirect=/account">
            <Button data-testid="account-signin-btn">Sign in</Button>
          </Link>
          <Link href="/sign-up?redirect=/account">
            <Button variant="outline" data-testid="account-signup-btn">
              Create account
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function AccountInner() {
  const { user } = useUser();
  const [data, setData] = useState<ShopMeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<boolean | null>(null);

  // Probe preview mode the same way the cart does so we can disable
  // payment actions cleanly when Stripe isn't configured.
  useEffect(() => {
    let active = true;
    fetchShopProducts()
      .then((r) => {
        if (!active) return;
        if ("unavailable" in r) {
          setPreviewMode(true);
        } else {
          setPreviewMode(r.previewMode);
        }
      })
      .catch(() => {
        if (active) setPreviewMode(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const reload = React.useCallback(async () => {
    try {
      const r = await fetchShopMe();
      setData(r);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError) {
    return (
      <div className="container mx-auto px-4 md:px-6 py-12 max-w-3xl">
        <div className="glass-card rounded-2xl p-6 text-center">
          <AlertCircle className="h-6 w-6 mx-auto mb-2 text-destructive" />
          <p className="text-sm text-muted-foreground">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="container mx-auto px-4 md:px-6 py-20 max-w-3xl text-center">
        <Loader2 className="h-6 w-6 mx-auto animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Defensive guard: the backend currently always returns `profile`
  // when signedIn=true, but the response shape declares it optional.
  // Rather than relying on `data.profile!` (a non-null assertion that
  // would crash the whole tree if the contract drifts), surface a
  // recoverable inline state so the user can retry instead of hitting
  // the global error boundary.
  if (!data.profile) {
    return (
      <div className="container mx-auto px-4 md:px-6 py-12 max-w-3xl">
        <div className="glass-card rounded-2xl p-6 text-center">
          <AlertCircle className="h-6 w-6 mx-auto mb-2 text-destructive" />
          <p className="text-sm text-muted-foreground mb-4">
            Your account info couldn't load. This is usually a momentary
            hiccup — try again in a few seconds.
          </p>
          <Button onClick={() => void reload()}>Try again</Button>
        </div>
      </div>
    );
  }

  const greeting =
    user?.firstName ?? data.profile.displayName?.split(" ")[0] ?? "there";

  return (
    <div className="container mx-auto px-4 md:px-6 py-12 md:py-16 max-w-4xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground mb-2">
          Your account
        </p>
        <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight mb-2">
          Welcome back, {greeting}.
        </h1>
        <p className="text-muted-foreground">
          Saved info means one-tap reorders. Card details stay with Stripe.
        </p>
      </div>

      {previewMode === true && <PreviewBanner />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <ProfileSection
            profile={data.profile!}
            onSaved={() => void reload()}
          />
          <ReorderSuggestionsSection />
          <SubscriptionsSection previewMode={previewMode === true} />
          <OrdersSection
            orders={data.recentOrders ?? []}
            previewMode={previewMode === true}
          />
          <CommPrefsSection />
        </div>
        <aside className="space-y-6">
          <SavedCardSection card={data.savedCard ?? null} />
          <KeepShoppingCard />
        </aside>
      </div>
    </div>
  );
}

function PreviewBanner() {
  return (
    <div
      className="glass-card rounded-xl p-4 mb-6 border-l-4 border-l-[hsl(var(--penn-gold))] flex gap-3"
      data-testid="account-preview-banner"
    >
      <AlertCircle className="h-5 w-5 text-[hsl(var(--penn-navy))] shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-semibold text-[hsl(var(--penn-navy))]">
          Preview mode — payments not yet enabled
        </p>
        <p className="text-muted-foreground mt-1">
          You can edit your saved info now. Reorder + Express checkout will
          enable as soon as Stripe is connected.
        </p>
      </div>
    </div>
  );
}

function ProfileSection({
  profile,
  onSaved,
}: {
  profile: NonNullable<ShopMeResponse["profile"]>;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [addr, setAddr] = useState<SavedShippingAddress>(
    profile.shippingAddress ?? {
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
    },
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cleanAddr: SavedShippingAddress = {
        line1: addr.line1.trim(),
        line2: addr.line2?.trim() || null,
        city: addr.city.trim(),
        state: addr.state.trim().toUpperCase(),
        postalCode: addr.postalCode.trim(),
        country: "US",
      };
      const hasAnyField =
        cleanAddr.line1 || cleanAddr.city || cleanAddr.state || cleanAddr.postalCode;
      const allRequiredFilled =
        cleanAddr.line1 && cleanAddr.city && cleanAddr.state && cleanAddr.postalCode;
      if (hasAnyField && !allRequiredFilled) {
        setError(
          "Fill in street, city, state, and ZIP — or clear all four to remove the saved address.",
        );
        setSaving(false);
        return;
      }
      await updateShopMe({
        displayName: displayName.trim() || null,
        shippingAddress: hasAnyField ? cleanAddr : null,
      });
      setSavedAt(Date.now());
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-profile-section"
    >
      <div className="flex items-center gap-2 mb-4">
        <UserIcon className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Profile & shipping</h2>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Full name">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            className="form-input"
            data-testid="account-name"
            autoComplete="name"
          />
        </Field>

        <div className="pt-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground mb-3 flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" /> Default shipping address
          </p>
          <div className="space-y-3">
            <Field label="Street address">
              <input
                type="text"
                value={addr.line1}
                onChange={(e) => setAddr({ ...addr, line1: e.target.value })}
                placeholder="123 Main St"
                className="form-input"
                data-testid="account-addr-line1"
                autoComplete="address-line1"
              />
            </Field>
            <Field label="Apt, suite, etc. (optional)">
              <input
                type="text"
                value={addr.line2 ?? ""}
                onChange={(e) => setAddr({ ...addr, line2: e.target.value })}
                placeholder="Apt 4B"
                className="form-input"
                data-testid="account-addr-line2"
                autoComplete="address-line2"
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="City">
                <input
                  type="text"
                  value={addr.city}
                  onChange={(e) => setAddr({ ...addr, city: e.target.value })}
                  className="form-input"
                  data-testid="account-addr-city"
                  autoComplete="address-level2"
                />
              </Field>
              <Field label="State">
                <input
                  type="text"
                  value={addr.state}
                  onChange={(e) =>
                    setAddr({
                      ...addr,
                      state: e.target.value.toUpperCase().slice(0, 2),
                    })
                  }
                  maxLength={2}
                  placeholder="CA"
                  className="form-input"
                  data-testid="account-addr-state"
                  autoComplete="address-level1"
                />
              </Field>
              <Field label="ZIP">
                <input
                  type="text"
                  value={addr.postalCode}
                  onChange={(e) =>
                    setAddr({ ...addr, postalCode: e.target.value })
                  }
                  inputMode="numeric"
                  className="form-input"
                  data-testid="account-addr-zip"
                  autoComplete="postal-code"
                />
              </Field>
            </div>
          </div>
        </div>

        {error && (
          <p
            className="text-sm text-destructive"
            data-testid="account-save-error"
          >
            {error}
          </p>
        )}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            disabled={saving}
            data-testid="account-save-btn"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span
              className="text-sm text-emerald-700 inline-flex items-center gap-1.5"
              data-testid="account-save-success"
            >
              <CheckCircle2 className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </form>

      <style>{`
        .form-input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border-radius: 0.5rem;
          border: 1px solid hsl(var(--border) / 0.6);
          background: white;
          font-size: 0.95rem;
          color: hsl(var(--foreground));
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .form-input:focus {
          outline: none;
          border-color: hsl(var(--penn-navy) / 0.6);
          box-shadow: 0 0 0 3px hsl(var(--penn-navy) / 0.12);
        }
      `}</style>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}

function SavedCardSection({ card }: { card: SavedCard | null }) {
  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-card-section"
    >
      <div className="flex items-center gap-2 mb-4">
        <CreditCard className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Saved card</h2>
      </div>
      {card && card.last4 ? (
        <div>
          <div className="rounded-xl bg-gradient-to-br from-[hsl(var(--penn-navy))] to-[hsl(var(--penn-navy)/0.85)] text-white p-5 mb-3">
            <p className="text-xs uppercase tracking-[0.16em] opacity-80 mb-2">
              {card.brand ?? "Card"} on file
            </p>
            <p
              className="font-semibold text-lg tracking-wider tabular-nums"
              data-testid="account-card-last4"
            >
              •••• •••• •••• {card.last4}
            </p>
            {card.expMonth && card.expYear && (
              <p className="text-xs opacity-80 mt-2">
                Expires {String(card.expMonth).padStart(2, "0")}/
                {String(card.expYear).slice(-2)}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            We never see your card number. Stripe holds the actual data —
            we only see the last 4 digits for display.
          </p>
        </div>
      ) : (
        <div>
          <p className="text-sm text-muted-foreground mb-3">
            No card saved yet. Your next checkout can save the card you use,
            so future orders are one tap.
          </p>
          <Link
            href="/shop"
            className="text-sm text-primary font-medium hover:underline inline-flex items-center gap-1"
          >
            Browse the shop <ShoppingBag className="h-4 w-4" />
          </Link>
        </div>
      )}
    </section>
  );
}

function KeepShoppingCard() {
  return (
    <section className="glass-card rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-3">
        <Package className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Keep CPAP fresh</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Cushions every 2 weeks, headgear twice a year, full reset every
        6 months. We'll have your saved info ready when it's time.
      </p>
      <div className="flex flex-col gap-2">
        <Link
          href="/shop"
          className="text-sm font-medium text-primary hover:underline"
          data-testid="account-link-shop"
        >
          → Browse supplies
        </Link>
        <Link
          href="/learn/replacement-schedule"
          className="text-sm font-medium text-primary hover:underline"
        >
          → Replacement schedule
        </Link>
      </div>
    </section>
  );
}

function OrdersSection({
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
          (li): li is typeof li & { priceId: string; unitAmountCents: number } =>
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
          No orders yet. Your first purchase will show up here for
          one-tap reorders.
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
        >
          {reorderError}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Subscriptions section — patient-managed Subscribe & Save lines.
// Self-fetches on mount because subscriptions live on a separate
// endpoint from /shop/me and we don't want to widen ShopMeResponse
// (subscriptions are a 0..N collection that warrants its own loading
// state, including a "Cancel auto-ship" pending state per row).
//
// Hidden when the user has zero subscriptions — the section's whole
// point is to be a quiet management surface, not to advertise the
// feature on accounts that haven't tried it. Discovery happens on
// /shop and /reminders; this section only manages.
// ---------------------------------------------------------------------------
// Per-row pending action — one of these at a time per subscription.
// `null` means the row is idle. We use a single state field rather
// than four booleans so the UI always disables every other button on
// the row while ONE is in flight (older patients double-tap things).
type PendingAction = "cancel" | "pause" | "resume";

function SubscriptionsSection({ previewMode }: { previewMode: boolean }) {
  const [subs, setSubs] = useState<ShopSubscriptionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    action: PendingAction;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Cadence dialog state. Held at the section level (not per-row) so
  // we can render a single shared <Dialog> instead of N dialogs.
  const [cadenceSub, setCadenceSub] = useState<ShopSubscriptionView | null>(
    null,
  );
  const [cadenceOptions, setCadenceOptions] = useState<
    ShopCadenceOption[] | null
  >(null);
  const [cadenceLoadError, setCadenceLoadError] = useState<string | null>(null);
  const [cadenceSelectedPriceId, setCadenceSelectedPriceId] = useState<
    string | null
  >(null);
  const [cadenceSubmitting, setCadenceSubmitting] = useState(false);

  // Cancel-intercept dialog — offers "Pause instead" before letting
  // the customer follow through with a hard cancel. Holds the
  // subscription targeted for cancellation (or null when closed)
  // plus an optional reason the customer chose, so we can log /
  // analyze later when we add a reasons table. The reason itself
  // is stored in component state only for now (no backend yet) —
  // the immediate goal is the deflection moment, not the analytics.
  const [cancelInterceptSub, setCancelInterceptSub] =
    useState<ShopSubscriptionView | null>(null);

  // Travel-mode bulk pause/resume in-flight flag.
  const [travelModeBusy, setTravelModeBusy] = useState(false);
  const [travelModeError, setTravelModeError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const r = await fetchShopMySubscriptions();
      setSubs(r.subscriptions);
    } catch (err: unknown) {
      // Treat 404 (route absent — preview mode without Stripe) and
      // every other read error the same: show nothing rather than a
      // scary banner. The section is opt-in surface; failing closed
      // is the right call.
      setSubs([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function isPending(id: string, action?: PendingAction) {
    if (!pending || pending.id !== id) return false;
    return action ? pending.action === action : true;
  }

  function handleCancel(sub: ShopSubscriptionView) {
    if (pending) return;
    // Open the cancel-intercept dialog instead of going straight to
    // a confirm-and-cancel. The dialog surfaces "Pause instead" as
    // the primary CTA — most patients who hit cancel just need a
    // break (vacation, hospital stay, supply backlog) rather than a
    // permanent stop. The native confirm() flow buried that option.
    setCancelInterceptSub(sub);
    setActionError(null);
  }

  async function confirmCancel(sub: ShopSubscriptionView) {
    setPending({ id: sub.id, action: "cancel" });
    setActionError(null);
    try {
      await cancelShopSubscription(sub.id);
      await load();
      setCancelInterceptSub(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function pauseFromIntercept(sub: ShopSubscriptionView) {
    setPending({ id: sub.id, action: "pause" });
    setActionError(null);
    try {
      await pauseShopSubscription(sub.id);
      await load();
      setCancelInterceptSub(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Pause / resume — both buttons are always shown when the sub is
  // active and not pending cancellation. We don't track local pause
  // state (no schema slice), so showing both lets the patient pick the
  // intent without us having to guess Stripe's `pause_collection`
  // value. Both endpoints are idempotent server-side.
  async function handlePause(sub: ShopSubscriptionView) {
    if (pending) return;
    if (
      !window.confirm(
        "Pause auto-ship? We'll stop charging your card and shipping until you " +
          "resume. Your subscription stays active so you can pick up where you left off.",
      )
    ) {
      return;
    }
    setPending({ id: sub.id, action: "pause" });
    setActionError(null);
    try {
      await pauseShopSubscription(sub.id);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function handleResume(sub: ShopSubscriptionView) {
    if (pending) return;
    setPending({ id: sub.id, action: "resume" });
    setActionError(null);
    try {
      await resumeShopSubscription(sub.id);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Travel mode — bulk-pause or bulk-resume every applicable
  // subscription with one click. Sequential rather than Promise.all so
  // we surface partial-failure state (Stripe rate limits + retry).
  // We don't store a "travel mode active" flag locally; the truth is
  // the subscriptions' actual paused/active state, which the next
  // load() reflects.
  async function bulkPauseAll(targets: ShopSubscriptionView[]) {
    if (travelModeBusy || pending) return;
    setTravelModeBusy(true);
    setTravelModeError(null);
    let failed = 0;
    for (const sub of targets) {
      try {
        await pauseShopSubscription(sub.id);
      } catch {
        failed += 1;
      }
    }
    await load();
    setTravelModeBusy(false);
    if (failed > 0) {
      setTravelModeError(
        `${failed} subscription${failed === 1 ? "" : "s"} couldn't be paused. ` +
          "Try the per-row Pause button.",
      );
    }
  }

  async function bulkResumeAll(targets: ShopSubscriptionView[]) {
    if (travelModeBusy || pending) return;
    setTravelModeBusy(true);
    setTravelModeError(null);
    let failed = 0;
    for (const sub of targets) {
      try {
        await resumeShopSubscription(sub.id);
      } catch {
        failed += 1;
      }
    }
    await load();
    setTravelModeBusy(false);
    if (failed > 0) {
      setTravelModeError(
        `${failed} subscription${failed === 1 ? "" : "s"} couldn't be resumed. ` +
          "Try the per-row Resume button.",
      );
    }
  }

  // Cadence dialog — opened by clicking "Change cadence" on a row.
  // We fetch the option list lazily on open (Stripe round-trip) so
  // the patient pays the latency only when they actually want it.
  async function openCadenceDialog(sub: ShopSubscriptionView) {
    setCadenceSub(sub);
    setCadenceOptions(null);
    setCadenceLoadError(null);
    setCadenceSelectedPriceId(null);
    try {
      const r = await fetchShopCadenceOptions(sub.id);
      setCadenceOptions(r.options);
      // Default-select the current cadence so the radio group has
      // a chosen value immediately (better than empty selection).
      const current = r.options.find((o) => o.isCurrent);
      if (current) setCadenceSelectedPriceId(current.priceId);
    } catch (err: unknown) {
      setCadenceLoadError(err instanceof Error ? err.message : String(err));
      setCadenceOptions([]);
    }
  }

  function closeCadenceDialog() {
    if (cadenceSubmitting) return;
    setCadenceSub(null);
    setCadenceOptions(null);
    setCadenceLoadError(null);
    setCadenceSelectedPriceId(null);
  }

  async function handleCadenceConfirm() {
    if (!cadenceSub || !cadenceSelectedPriceId) return;
    // No-op if the patient didn't actually change their selection —
    // the server short-circuits this too, but skipping the round-trip
    // makes the UX feel snappier on close.
    const current = cadenceOptions?.find((o) => o.isCurrent);
    if (current?.priceId === cadenceSelectedPriceId) {
      closeCadenceDialog();
      return;
    }
    setCadenceSubmitting(true);
    setActionError(null);
    try {
      await changeShopSubscriptionCadence(
        cadenceSub.id,
        cadenceSelectedPriceId,
      );
      await load();
      // Close AFTER the load completes so the dialog visibly reflects
      // the new state on the row underneath when it disappears.
      setCadenceSub(null);
      setCadenceOptions(null);
      setCadenceSelectedPriceId(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCadenceSubmitting(false);
    }
  }

  // While loading, render nothing — avoids flicker for the common
  // case of "this user has no subscriptions" which is the empty-state
  // we hide entirely.
  if (subs === null) return null;
  if (subs.length === 0) {
    // Hide the section entirely when empty (per spec). The load
    // error, if any, surfaces only on next mount — accept that as a
    // tradeoff to keep the empty-state silent.
    if (loadError) {
      // dev-mode breadcrumb; never user-visible.
      // eslint-disable-next-line no-console
      console.debug("[account] subscriptions load skipped:", loadError);
    }
    return null;
  }

  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-subscriptions-section"
    >
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Repeat className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Auto-ship subscriptions</h2>
        </div>
        {(() => {
          // Bulk pause-everything is only useful when there's at least one
          // subscription that could meaningfully change. We show "Pause
          // all" if anything is active and "Resume all" if every active
          // subscription is paused (Stripe `paused` status). When the
          // collection is mixed we render Pause All — pausing what's
          // active is the higher-leverage action.
          const pauseTargets = subs.filter(
            (s) => s.status === "active" || s.status === "trialing",
          );
          const pausedTargets = subs.filter((s) => s.status === "paused");
          if (pauseTargets.length > 0) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void bulkPauseAll(pauseTargets)}
                disabled={travelModeBusy || pending !== null}
                data-testid="account-travel-mode-pause-all"
                title="Pause every active auto-ship — useful for travel or hospital stays."
              >
                {travelModeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Pausing all…
                  </>
                ) : (
                  <>Pause all (travel mode)</>
                )}
              </Button>
            );
          }
          if (pausedTargets.length > 1) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void bulkResumeAll(pausedTargets)}
                disabled={travelModeBusy || pending !== null}
                data-testid="account-travel-mode-resume-all"
              >
                {travelModeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Resuming all…
                  </>
                ) : (
                  <>Resume all</>
                )}
              </Button>
            );
          }
          return null;
        })()}
      </div>
      {travelModeError && (
        <p
          className="text-xs text-rose-700 mb-3"
          role="alert"
          data-testid="account-travel-mode-error"
        >
          {travelModeError}
        </p>
      )}
      <ul className="divide-y divide-border/40">
        {subs.map((sub) => {
          const isActive = sub.status === "active" || sub.status === "trialing";
          const isPastDue = sub.status === "past_due" || sub.status === "unpaid";
          const isCanceled =
            sub.status === "canceled" || sub.status === "incomplete_expired";
          const nextShip = sub.currentPeriodEnd
            ? new Date(sub.currentPeriodEnd)
            : null;
          return (
            <li
              key={sub.id}
              className="py-4 first:pt-0 last:pb-0"
              data-testid={`account-subscription-${sub.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <ul className="space-y-1">
                    {sub.items.map((item) => (
                      <li
                        key={item.priceId}
                        className="text-sm font-medium tabular-nums"
                      >
                        {item.quantity > 1 ? `${item.quantity}× ` : ""}
                        {item.name ?? item.priceId}
                        {item.intervalLabel && (
                          <span className="text-xs text-muted-foreground ml-2 font-normal">
                            every {item.intervalLabel}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {nextShip && isActive && !sub.cancelAtPeriodEnd && (
                      <span className="inline-flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" />
                        Next ship{" "}
                        {nextShip.toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                    {sub.cancelAtPeriodEnd && nextShip && (
                      <span className="inline-flex items-center gap-1 text-[hsl(var(--penn-navy))]">
                        <XCircle className="h-3 w-3" />
                        Stops after{" "}
                        {nextShip.toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                    {isPastDue && (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <AlertCircle className="h-3 w-3" />
                        Payment past due — update card on file
                      </span>
                    )}
                    {isCanceled && (
                      <span className="inline-flex items-center gap-1">
                        <XCircle className="h-3 w-3" />
                        Canceled
                      </span>
                    )}
                  </div>
                </div>
                {!isCanceled && !sub.cancelAtPeriodEnd && (
                  // Vertical button column on the right keeps the
                  // four CTAs from wrapping awkwardly on mobile, and
                  // lets us put the destructive action visually last.
                  // Pause + Resume are both shown unconditionally
                  // because we don't track local pause state — see
                  // the comment block at the top of the section.
                  <div className="flex flex-col items-stretch gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void handlePause(sub)}
                      data-testid={`account-subscription-pause-${sub.id}`}
                      title={
                        previewMode
                          ? "Pause will be available once Stripe is connected."
                          : "Pause auto-ship and stop charges until you resume."
                      }
                    >
                      {isPending(sub.id, "pause") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Pausing…
                        </>
                      ) : (
                        <>
                          <Pause className="h-3.5 w-3.5 mr-1.5" />
                          Pause
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void handleResume(sub)}
                      data-testid={`account-subscription-resume-${sub.id}`}
                      title={
                        previewMode
                          ? "Resume will be available once Stripe is connected."
                          : "Resume auto-ship if it's currently paused."
                      }
                    >
                      {isPending(sub.id, "resume") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Resuming…
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5 mr-1.5" />
                          Resume
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void openCadenceDialog(sub)}
                      data-testid={`account-subscription-cadence-${sub.id}`}
                      title={
                        previewMode
                          ? "Cadence changes will be available once Stripe is connected."
                          : "Change how often supplies arrive."
                      }
                    >
                      <Settings2 className="h-3.5 w-3.5 mr-1.5" />
                      Change cadence
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void handleCancel(sub)}
                      data-testid={`account-subscription-cancel-${sub.id}`}
                      title={
                        previewMode
                          ? "Auto-ship will be cancellable as soon as Stripe is connected."
                          : undefined
                      }
                    >
                      {isPending(sub.id, "cancel") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Cancelling…
                        </>
                      ) : (
                        "Cancel auto-ship"
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {actionError && (
        <p
          className="mt-3 text-sm text-destructive"
          data-testid="account-subscription-action-error"
        >
          {actionError}
        </p>
      )}

      {/* Cadence-change dialog — shared across all rows; opens with
          the row's options pre-fetched. We render the radio group
          inline (rather than a Select) because older patients find
          radios easier to scan and the option list is short (≤ ~6). */}
      <Dialog
        open={cadenceSub !== null}
        onOpenChange={(o) => {
          if (!o) closeCadenceDialog();
        }}
      >
        <DialogContent
          data-testid="account-cadence-dialog"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>Change auto-ship cadence</DialogTitle>
            <DialogDescription>
              Choose how often you'd like your supplies to ship. Changes apply
              to your next order — we won't re-charge you for the current
              period.
            </DialogDescription>
          </DialogHeader>
          {cadenceOptions === null && !cadenceLoadError && (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading options…
            </div>
          )}
          {cadenceLoadError && (
            <p className="py-4 text-sm text-destructive">
              Couldn't load cadence options. Please try again.
            </p>
          )}
          {cadenceOptions !== null && cadenceOptions.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No alternate shipping cadences are available for this product.
            </p>
          )}
          {cadenceOptions !== null && cadenceOptions.length > 0 && (
            <RadioGroup
              value={cadenceSelectedPriceId ?? ""}
              onValueChange={(v) => setCadenceSelectedPriceId(v)}
              className="space-y-2 py-2"
            >
              {cadenceOptions.map((opt) => {
                const inputId = `cadence-opt-${opt.priceId}`;
                const price =
                  opt.unitAmountCents != null && opt.currency
                    ? formatMoneyCents(opt.unitAmountCents, opt.currency)
                    : null;
                return (
                  <div
                    key={opt.priceId}
                    className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2 hover:bg-accent/30"
                  >
                    <RadioGroupItem value={opt.priceId} id={inputId} />
                    <Label
                      htmlFor={inputId}
                      className="flex-1 cursor-pointer text-sm font-normal"
                    >
                      <span className="font-medium">
                        Every {opt.intervalLabel}
                      </span>
                      {price && (
                        <span className="ml-2 text-muted-foreground tabular-nums">
                          · {price}
                        </span>
                      )}
                      {opt.isCurrent && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (current)
                        </span>
                      )}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeCadenceDialog}
              disabled={cadenceSubmitting}
              data-testid="account-cadence-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCadenceConfirm()}
              disabled={
                cadenceSubmitting ||
                !cadenceSelectedPriceId ||
                cadenceOptions === null ||
                cadenceOptions.length === 0
              }
              data-testid="account-cadence-confirm"
            >
              {cadenceSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save cadence"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelInterceptSub !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setCancelInterceptSub(null);
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          data-testid="account-cancel-intercept-dialog"
        >
          <DialogHeader>
            <DialogTitle>Before you cancel — would a pause work?</DialogTitle>
            <DialogDescription>
              Most patients who hit Cancel just need a temporary break. Pause
              keeps your subscription on file with no charges; you resume in
              one tap when you&apos;re ready.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-xl border border-[hsl(var(--penn-gold)/0.4)] bg-[hsl(var(--penn-gold)/0.06)] p-4">
              <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                Pause auto-ship instead
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                We&apos;ll stop charging your card and pause shipments. Your
                cadence and payment method stay on file. Resume anytime from
                this page.
              </p>
            </div>
            <div className="rounded-xl border bg-background p-4">
              <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                Cancel for good
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Your supplies will keep shipping until the end of the current
                period, then stop. You&apos;ll need to re-subscribe (and
                re-confirm cadence + price) if you change your mind later.
              </p>
            </div>
            {actionError && (
              <p className="text-xs text-rose-700" role="alert">
                {actionError}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setCancelInterceptSub(null)}
              disabled={pending !== null}
              data-testid="account-cancel-intercept-keep"
            >
              Keep auto-ship as-is
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                cancelInterceptSub && void confirmCancel(cancelInterceptSub)
              }
              disabled={pending !== null}
              className="border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              data-testid="account-cancel-intercept-confirm"
            >
              {isPending(cancelInterceptSub?.id ?? "", "cancel") ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Canceling…
                </>
              ) : (
                "Cancel anyway"
              )}
            </Button>
            <Button
              onClick={() =>
                cancelInterceptSub && void pauseFromIntercept(cancelInterceptSub)
              }
              disabled={pending !== null}
              data-testid="account-cancel-intercept-pause"
            >
              {isPending(cancelInterceptSub?.id ?? "", "pause") ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Pausing…
                </>
              ) : (
                "Pause instead"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// Re-export for App.tsx import consistency.
export default AccountPage;
// Reference basePath so unused-var lint stays clean even if a future
// edit drops its only consumer.
void basePath;
