// /shop/cart — review + checkout for the cash-pay shop.
//
// "Checkout with card" POSTs to /resupply-api/shop/checkout, which
// returns a Stripe Hosted Checkout URL. We redirect via
// window.location.assign — Stripe owns the next-page UX (card form,
// 3DS, etc.) and bounces back to /shop/checkout-success on completion
// or /shop/cart on cancel.
//
// We deliberately do NOT clear the cart here on click. Clearing
// happens only on the success page after a confirmed paid status, so
// a user who closes the Stripe tab still has their cart intact.

import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Info,
  Lock,
  Minus,
  Plus,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCart } from "@/hooks/use-cart";
import {
  fetchShopProducts,
  formatMoneyCents,
  startCheckout,
} from "@/lib/shop-api";
import {
  AccountApiError,
  fetchShopMe,
  startQuickCheckout,
  type SavedCard,
} from "@/lib/account-api";

export function ShopCart() {
  const { items, totalCents, setQuantity, removeItem } = useCart();
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tri-state preview probe: `null` until the products fetch resolves,
  // then `true`/`false`. Keeping it tri-state lets us disable Checkout
  // during the probe so a fast click can't beat the response and POST
  // to /shop/checkout (the server would 503 anyway, but disabling
  // avoids a flash-of-error). The /shop/products endpoint is cached
  // server-side for 60s, so this single GET is cheap.
  const [previewMode, setPreviewMode] = useState<boolean | null>(null);
  // Auth + saved-card probe for the Express Checkout button. Same
  // tri-state pattern as previewMode: `null` means "still finding out"
  // and we hide the Express button until we know — flashing a button
  // and then yanking it would feel jankier than waiting one tick.
  const [savedCard, setSavedCard] = useState<SavedCard | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [expressCheckingOut, setExpressCheckingOut] = useState(false);

  useEffect(() => {
    // Only probe /shop/me if there are items in the cart — there's
    // no point asking the server about the user when nothing is being
    // checked out.
    if (items.length === 0) {
      setSignedIn(false);
      setSavedCard(null);
      return;
    }
    let active = true;
    fetchShopMe()
      .then((me) => {
        if (!active) return;
        setSignedIn(me.signedIn);
        setSavedCard(me.savedCard ?? null);
      })
      .catch(() => {
        // Express checkout is a progressive enhancement; failures
        // here just mean the user sees only the standard checkout.
        if (active) {
          setSignedIn(false);
          setSavedCard(null);
        }
      });
    return () => {
      active = false;
    };
  }, [items.length]);

  useEffect(() => {
    let active = true;
    fetchShopProducts()
      .then((r) => {
        if (!active) return;
        if ("unavailable" in r) {
          // Treat hard-503 as preview-equivalent for the cart: no
          // checkout possible either way.
          setPreviewMode(true);
          return;
        }
        setPreviewMode(r.previewMode);
      })
      .catch(() => {
        // Fail open to "live" so a transient products fetch failure
        // doesn't block a real customer's checkout. The button click
        // path still surfaces the real error if checkout itself fails.
        if (active) setPreviewMode(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const probing = previewMode === null;

  async function handleCheckout() {
    if (items.length === 0) return;
    if (previewMode !== false) return;
    setError(null);
    setCheckingOut(true);
    try {
      const { url } = await startCheckout(
        items.map((i) => ({ priceId: i.priceId, quantity: i.quantity })),
      );
      window.location.assign(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setCheckingOut(false);
    }
  }

  // Express checkout for signed-in users with a saved card. Same
  // payload shape as standard checkout, but lands on
  // /shop/me/quick-checkout which attaches the Stripe Customer and
  // sets payment_method_collection: 'if_required' — the user sees
  // a one-tap "Pay $X.XX" button on the Stripe page.
  async function handleExpressCheckout() {
    if (items.length === 0) return;
    if (previewMode !== false) return;
    setError(null);
    setExpressCheckingOut(true);
    try {
      const { url } = await startQuickCheckout({
        items: items.map((i) => ({ priceId: i.priceId, quantity: i.quantity })),
      });
      window.location.assign(url);
    } catch (err: unknown) {
      const msg =
        err instanceof AccountApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setError(msg);
      setExpressCheckingOut(false);
    }
  }

  const showExpressCheckout =
    signedIn === true &&
    savedCard !== null &&
    savedCard.last4 !== null &&
    previewMode === false;

  return (
    <div className="container mx-auto px-4 md:px-6 py-12 md:py-16 max-w-4xl">
      <div className="mb-10">
        <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight mb-2">
          Your cart
        </h1>
        <p className="text-muted-foreground">
          Review your items, then check out securely with Stripe.
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyCart />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-3">
            {items.map((it) => (
              <div
                key={it.priceId}
                className="glass-card rounded-2xl p-5 flex items-start gap-4"
                data-testid={`cart-line-${it.priceId}`}
              >
                <div className="shrink-0 h-14 w-14 rounded-xl bg-secondary/40 flex items-center justify-center text-muted-foreground">
                  <ShoppingBag className="w-6 h-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium leading-snug">{it.name}</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {formatMoneyCents(it.unitAmountCents, it.currency)} each
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="inline-flex items-center rounded-lg border border-border/60 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setQuantity(it.priceId, it.quantity - 1)}
                        className="px-2 py-1.5 text-muted-foreground hover:bg-secondary/40 transition-colors"
                        aria-label={`Decrease quantity of ${it.name}`}
                        data-testid={`cart-decr-${it.priceId}`}
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span
                        className="px-3 text-sm tabular-nums min-w-[2ch] text-center"
                        data-testid={`cart-qty-${it.priceId}`}
                      >
                        {it.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => setQuantity(it.priceId, it.quantity + 1)}
                        className="px-2 py-1.5 text-muted-foreground hover:bg-secondary/40 transition-colors"
                        aria-label={`Increase quantity of ${it.name}`}
                        data-testid={`cart-incr-${it.priceId}`}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(it.priceId)}
                      className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1.5 transition-colors"
                      data-testid={`cart-remove-${it.priceId}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-semibold tabular-nums">
                    {formatMoneyCents(
                      it.unitAmountCents * it.quantity,
                      it.currency,
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <aside className="lg:col-span-1">
            <div className="glass-card rounded-2xl p-6 sticky top-24">
              <h2 className="font-semibold mb-4">Order summary</h2>
              <dl className="space-y-2 text-sm mb-4">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Subtotal</dt>
                  <dd className="tabular-nums" data-testid="cart-subtotal">
                    {formatMoneyCents(totalCents)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Shipping</dt>
                  <dd className="text-muted-foreground">Calculated by Stripe</dd>
                </div>
              </dl>
              <div className="border-t border-border/40 pt-4 mb-4 flex justify-between">
                <span className="font-semibold">Total</span>
                <span
                  className="font-semibold text-lg tabular-nums"
                  data-testid="cart-total"
                >
                  {formatMoneyCents(totalCents)}
                </span>
              </div>
              {error && (
                <p
                  className="text-sm text-destructive mb-3"
                  data-testid="cart-error"
                >
                  {error}
                </p>
              )}
              {previewMode === true && (
                <div
                  className="rounded-xl border border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/10 px-3 py-3 mb-3 flex items-start gap-2"
                  data-testid="cart-preview-banner"
                  role="status"
                >
                  <Info className="w-4 h-4 shrink-0 mt-0.5 text-[hsl(var(--penn-navy))]" />
                  <p className="text-xs leading-relaxed text-foreground/85">
                    <span className="font-semibold text-[hsl(var(--penn-navy))]">
                      Preview mode.
                    </span>{" "}
                    Card checkout opens once Stripe is connected — no charge
                    will be made today.
                  </p>
                </div>
              )}
              {showExpressCheckout && (
                <div className="mb-3" data-testid="cart-express-block">
                  <Button
                    onClick={handleExpressCheckout}
                    disabled={expressCheckingOut || checkingOut}
                    className="w-full bg-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-navy)/0.9)] text-white"
                    data-testid="cart-express-checkout"
                  >
                    {expressCheckingOut ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Redirecting…
                      </>
                    ) : (
                      <>
                        <Lock className="w-4 h-4 mr-2" />
                        Express checkout — pay with{" "}
                        {savedCard?.brand ?? "card"} ••••{savedCard?.last4}
                      </>
                    )}
                  </Button>
                  <div className="my-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <div className="flex-1 h-px bg-border/50" />
                    <span>or</span>
                    <div className="flex-1 h-px bg-border/50" />
                  </div>
                </div>
              )}
              <Button
                onClick={handleCheckout}
                disabled={checkingOut || probing || previewMode === true}
                className="w-full"
                data-testid="cart-checkout"
              >
                {previewMode === true ? (
                  <>
                    <Lock className="w-4 h-4 mr-2" /> Checkout disabled in
                    preview
                  </>
                ) : probing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Preparing checkout…
                  </>
                ) : checkingOut ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Redirecting…
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4 mr-2" /> Checkout with card
                  </>
                )}
              </Button>
              <p className="text-[11px] text-muted-foreground mt-3 text-center leading-relaxed">
                {previewMode === true
                  ? "Use the insurance flow below — it's $0 with a prescription and fully live today."
                  : "Secure payment processed by Stripe. We never see your card details."}
              </p>

              <div className="border-t border-border/40 mt-5 pt-4 text-center">
                <Link
                  href="/order"
                  className="text-xs text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-1.5"
                  data-testid="cart-insurance-link"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Have insurance? Use it for $0 →
                </Link>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function EmptyCart() {
  return (
    <div
      className="glass-card rounded-2xl p-12 text-center"
      data-testid="cart-empty"
    >
      <div className="flex justify-center mb-4">
        <div className="h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
          <ShoppingBag className="w-6 h-6" />
        </div>
      </div>
      <h2 className="text-xl font-semibold tracking-tight mb-2">
        Your cart is empty.
      </h2>
      <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
        Browse cushions, tubing, filters, and curated bundles, or skip
        the cash flow entirely and use your insurance.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link href="/shop">
          <Button data-testid="cart-empty-shop">
            Browse the shop <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </Link>
        <Link href="/order">
          <Button variant="outline" data-testid="cart-empty-insurance">
            Use insurance ($0)
          </Button>
        </Link>
      </div>
    </div>
  );
}
