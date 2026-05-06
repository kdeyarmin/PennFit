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

import React, { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  ArrowRight,
  Info,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  X,
  Loader2,
} from "lucide-react";

import { Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useCart, type CartItem } from "@/hooks/use-cart";
import {
  addToWishlist,
  isInWishlist,
  removeFromWishlist,
} from "@/lib/wishlist";
import {
  fetchShopProducts,
  formatMoneyCents,
  startCheckout,
  type ShopProductView,
} from "@/lib/shop-api";
import {
  AccountApiError,
  fetchShopMe,
  startQuickCheckout,
  type SavedCard,
} from "@/lib/account-api";
import { ComfortGuarantee } from "@/components/comfort-guarantee";
import { CostTransparencyCallout } from "@/components/cost-transparency-callout";
import { ShippingEta } from "@/components/shop/shipping-eta";
import { CartCrossSell } from "@/components/shop/cart-cross-sell";
import { HsaFsaBadge } from "@/components/shop/hsa-fsa-badge";

// sessionStorage key written by /account when the user clicks
// "Buy this again". Reading + clearing it here is the only handshake
// between the two pages — keeps the contract narrow.
const REORDER_FROM_KEY = "pennpaps_reorder_from";

// Snapshot row shape returned by GET /shop/me/cart-snapshot. Mirrors
// what the server stores; we only consume `items` here.
interface CartSnapshotItem {
  priceId: string;
  productId: string;
  name: string;
  quantity: number;
  unitAmountCents: number;
  currency: string;
  mode: "one_time" | "subscription";
  recurringPriceId: string | null;
  recurringIntervalLabel: string | null;
  imageUrl: string | null;
  isBundle: boolean;
}

interface ReorderSource {
  sessionId: string;
  createdAt: string;
  // How many line items from the original order COULDN'T be loaded
  // (archived Stripe prices, missing priceId, etc). Surfaced in the
  // banner so customers don't wonder why their cart is shorter than
  // they remember. Optional for forward-compat with older flag
  // payloads sitting in sessionStorage.
  droppedCount?: number;
}

/**
 * Tri-state result of the ?resume=1 rehydration probe:
 *   "rehydrated"      — items merged from the server snapshot
 *   "needs_signin"    — visitor hit the link signed-out
 *   "nothing_to_do"   — server had no items / local cart already richer
 *   null              — no ?resume=1 in URL, or probe still in flight
 */
type ResumeState = "rehydrated" | "needs_signin" | "nothing_to_do" | null;

export function ShopCart() {
  useDocumentTitle("Your cart");
  const {
    items,
    totalCents,
    setQuantity,
    removeItem,
    addItem,
    setItemMode,
    replaceItems,
  } = useCart();
  const { toast } = useToast();
  // Per-item draft quantity string. Lets the user clear the field
  // mid-edit without the controlled input snapping back to the
  // previous value. Cleared on blur so the display re-syncs with
  // committed cart state.
  const [draftQty, setDraftQty] = useState<Record<string, string>>({});

  /**
   * Remove a cart line and surface an Undo toast. The snapshot
   * captures the full CartItem at click time so Undo can replay the
   * exact quantity / mode / subscription cadence — not just the SKU.
   * If the shopper undoes, we also re-stamp the wishlist (when the
   * removal had previously been a "Save for later" click); see
   * `handleSaveForLater` below for how the two flows compose.
   */
  function handleRemove(
    it: CartItem,
    opts?: { savedForLater?: boolean; addedToWishlist?: boolean },
  ) {
    const snapshot: CartItem = { ...it };
    removeItem(it.priceId);
    toast({
      title: opts?.savedForLater ? "Saved for later" : "Removed from cart",
      description: opts?.savedForLater
        ? `“${it.name}” moved to your saved items.`
        : `“${it.name}” removed.`,
      action: (
        <ToastAction
          altText={`Undo removing ${it.name}`}
          onClick={() => {
            // Re-add at the original quantity. addItem caps at 20
            // and skips out-of-stock; both are correct fallbacks
            // for an Undo a few seconds after the original click.
            addItem(snapshot, snapshot.quantity);
            if (opts?.addedToWishlist) {
              // Symmetrical undo: pull it back out of the wishlist
              // only when Save-for-later actually added it. If the
              // item was already wishlisted before this click we
              // leave it there — Undo shouldn't clobber a separate
              // saved-item the shopper created independently.
              removeFromWishlist(snapshot.productId);
            }
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  }

  /** Wishlist-bound counterpart to handleRemove. */
  function handleSaveForLater(it: CartItem) {
    // Track whether *this* click is responsible for the wishlist entry
    // so the Undo handler knows whether to reverse the write.
    const addedToWishlist = !isInWishlist(it.productId);
    if (addedToWishlist) {
      addToWishlist(it.productId);
    }
    handleRemove(it, { savedForLater: true, addedToWishlist });
  }
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reorder breadcrumb — populated from sessionStorage on mount if the
  // user just came from /account's "Buy this again". We read it once
  // and hold it in component state so dismissing the banner survives
  // re-renders without us having to write back to sessionStorage on
  // every keystroke.
  const [reorderSource, setReorderSource] = useState<ReorderSource | null>(
    null,
  );
  // Cart-abandonment ?resume=1 rehydration. Tri-state — null until we
  // know whether the URL had the marker; one of three terminal states
  // after the probe completes. The banner UI keys off this.
  const [resumeState, setResumeState] = useState<ResumeState>(null);
  // Live mirror of `items.length` so the resume probe — which fires
  // exactly once on mount — reads the *current* cart length when the
  // snapshot fetch resolves, not the snapshot it captured at mount.
  // Without this ref, a user who lands at /shop/cart?resume=1 and
  // adds an item before the network roundtrip completes can have the
  // newly-added item silently overwritten by `replaceItems(...)`. We
  // update on every render so the value the effect reads is always
  // fresh at decision time.
  const itemsLenRef = useRef(items.length);
  itemsLenRef.current = items.length;
  useEffect(() => {
    // Run the resume probe at most once per mount. Detect ?resume=1
    // BEFORE we strip it from the URL so a back-button hit doesn't
    // re-trigger us (we strip immediately).
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("resume") !== "1") return;
    // Strip ?resume=1 from the address bar straight away — don't want
    // the marker to leak into shareable URLs or to re-trigger on a
    // browser refresh.
    try {
      params.delete("resume");
      const qs = params.toString();
      const next =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", next);
    } catch {
      // History API not available (very old browser): no-op.
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/resupply-api/shop/me/cart-snapshot", {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (res.status === 401) {
          setResumeState("needs_signin");
          return;
        }
        if (!res.ok) {
          setResumeState("nothing_to_do");
          return;
        }
        const data = (await res.json()) as unknown;
        const serverItems =
          data !== null &&
          typeof data === "object" &&
          Array.isArray((data as Record<string, unknown>).items)
            ? ((data as { items: CartSnapshotItem[] }).items)
            : [];
        if (serverItems.length === 0) {
          setResumeState("nothing_to_do");
          return;
        }
        // Merge policy: only overwrite the local cart when the server
        // snapshot is "more complete" than what's in this browser.
        // Concretely: local empty (the common cross-device case) OR
        // local strictly fewer line items than the server. Avoids
        // clobbering an in-progress cart that the user already started
        // adding to in this browser before clicking the email link.
        //
        // CRITICAL: read from itemsLenRef.current, NOT from the
        // captured `items` closure — the user may have added or
        // removed items between mount (when this effect started) and
        // now (when the network fetch resolved). Using the ref makes
        // the merge decision against the live cart state.
        const localLen = itemsLenRef.current;
        const serverLen = serverItems.length;
        if (localLen > 0 && localLen >= serverLen) {
          setResumeState("nothing_to_do");
          return;
        }
        replaceItems(
          serverItems.map((it) => ({
            productId: it.productId,
            priceId: it.priceId,
            name: it.name,
            unitAmountCents: it.unitAmountCents,
            currency: it.currency,
            quantity: it.quantity,
            imageUrl: it.imageUrl,
            isBundle: it.isBundle,
            mode: it.mode,
            recurringPriceId: it.recurringPriceId,
            recurringIntervalLabel: it.recurringIntervalLabel,
            // Server-side cart-resume snapshots predate the
            // inventory feature and don't carry stock counts.
            // Same convention as the localStorage hydrate path
            // in use-cart.ts: null = "not tracked here, the live
            // product fetch + checkout validation will catch
            // out-of-stock before the user can pay."
            stockCount: null,
          })),
        );
        setResumeState("rehydrated");
      } catch {
        if (!cancelled) setResumeState("nothing_to_do");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount only — items/replaceItems are intentionally
    // omitted to avoid re-running after we just called replaceItems.
    // The ref above keeps us in sync with the live cart length without
    // re-firing the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(REORDER_FROM_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<ReorderSource>;
      if (
        parsed &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.createdAt === "string"
      ) {
        setReorderSource({
          sessionId: parsed.sessionId,
          createdAt: parsed.createdAt,
          droppedCount:
            typeof parsed.droppedCount === "number"
              ? parsed.droppedCount
              : undefined,
        });
      }
      // Clear the storage flag immediately — if the user closes the
      // banner, navigates away, and returns to /shop/cart later, the
      // banner should NOT reappear. Component state still keeps the
      // banner visible for this mount.
      window.sessionStorage.removeItem(REORDER_FROM_KEY);
    } catch {
      // Malformed JSON or storage blocked — silently no banner.
    }
  }, []);
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

  // Catalog snapshot is reused for two things on this page:
  //   1. previewMode flag (existing behavior — gates real checkout)
  //   2. CartCrossSell input (new — the strip needs the full
  //      catalog to pick complementary categories)
  // We fetch once on mount and keep both in sync from the same call
  // so the user doesn't see flicker between them.
  const [catalog, setCatalog] = useState<ShopProductView[]>([]);
  useEffect(() => {
    let active = true;
    fetchShopProducts()
      .then((r) => {
        if (!active) return;
        if ("unavailable" in r) {
          // Treat hard-503 as preview-equivalent for the cart: no
          // checkout possible either way. Catalog stays empty so the
          // cross-sell strip self-hides.
          setPreviewMode(true);
          return;
        }
        setPreviewMode(r.previewMode);
        setCatalog(r.products);
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
        items.map((i) => ({
          // Subscribe & Save: when this line is in subscription mode,
          // send the recurring priceId so Stripe builds a recurring
          // line item. The cart's stable key remains the one-time
          // priceId regardless of mode.
          priceId:
            i.mode === "subscription" && i.recurringPriceId
              ? i.recurringPriceId
              : i.priceId,
          quantity: i.quantity,
          mode:
            i.mode === "subscription" && i.recurringPriceId
              ? "subscription"
              : "one_time",
        })),
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
        items: items.map((i) => ({
          priceId:
            i.mode === "subscription" && i.recurringPriceId
              ? i.recurringPriceId
              : i.priceId,
          quantity: i.quantity,
          mode:
            i.mode === "subscription" && i.recurringPriceId
              ? "subscription"
              : "one_time",
        })),
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
    } finally {
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
          Review your items, then continue to secure checkout.
        </p>
      </div>

      {/*
        Resume-from-email banners. Rendered ABOVE the EmptyCart fork so
        a signed-out visitor who clicked the email link sees a
        sign-in prompt instead of the generic empty cart. The
        "rehydrated" variant only renders alongside actual items.
      */}
      {resumeState === "needs_signin" && (
        <div
          className="glass-card rounded-2xl p-4 mb-6 border-l-4 border-l-[hsl(var(--penn-gold))] flex items-start gap-3"
          data-testid="cart-resume-needs-signin"
        >
          <RefreshCw className="h-5 w-5 text-[hsl(var(--penn-navy))] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-semibold text-[hsl(var(--penn-navy))]">
              Sign in to restore your cart
            </p>
            <p className="text-muted-foreground mt-0.5">
              You came from a saved-cart email. Sign in with the email that
              received it and we'll bring your items back.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setResumeState(null)}
            className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
            aria-label="Dismiss restore-cart prompt"
            data-testid="cart-resume-dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyCart />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-3">
            {resumeState === "rehydrated" && (
              <div
                className="glass-card rounded-2xl p-4 border-l-4 border-l-[hsl(var(--penn-gold))] flex items-start gap-3"
                data-testid="cart-resume-rehydrated"
              >
                <RefreshCw className="h-5 w-5 text-[hsl(var(--penn-navy))] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-sm">
                  <p className="font-semibold text-[hsl(var(--penn-navy))]">
                    We restored your cart from the email reminder
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    Adjust quantities or remove anything you don't need before
                    checking out.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setResumeState(null)}
                  className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                  aria-label="Dismiss restored-cart banner"
                  data-testid="cart-resume-rehydrated-dismiss"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            {reorderSource && (
              <div
                className="glass-card rounded-2xl p-4 border-l-4 border-l-[hsl(var(--penn-gold))] flex items-start gap-3"
                data-testid="cart-reorder-banner"
              >
                <RefreshCw className="h-5 w-5 text-[hsl(var(--penn-navy))] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-sm">
                  <p className="font-semibold text-[hsl(var(--penn-navy))]">
                    Loaded from your order on{" "}
                    {new Date(reorderSource.createdAt).toLocaleDateString(
                      undefined,
                      { year: "numeric", month: "short", day: "numeric" },
                    )}
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    Adjust quantities or remove anything you don't need before
                    checking out.
                  </p>
                  {(reorderSource.droppedCount ?? 0) > 0 && (
                    <p
                      className="text-amber-700 mt-1.5 flex items-start gap-1.5"
                      data-testid="cart-reorder-banner-dropped"
                    >
                      <Info className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>
                        {reorderSource.droppedCount === 1
                          ? "1 item from that order is no longer available and was skipped."
                          : `${reorderSource.droppedCount} items from that order are no longer available and were skipped.`}
                      </span>
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setReorderSource(null)}
                  className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                  aria-label="Dismiss reorder banner"
                  data-testid="cart-reorder-banner-dismiss"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
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
                      {/*
                        Editable quantity input. The previous version
                        was a silent <span>, which forced shoppers to
                        click the +/− buttons N times to reach a
                        non-trivial quantity (qty 12 = 11 clicks).
                        Now the value is a typed input bracketed by
                        the same +/− buttons. setQuantity already
                        clamps to [0, 20] and integerizes mid-stroke
                        fractional inputs, so the only thing this
                        handler needs to do is parse the string.
                        Empty input is treated as 1 on blur (the
                        cart-line-removed semantic for qty 0 already
                        belongs to the explicit Remove button).
                      */}
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={draftQty[it.priceId] ?? String(it.quantity)}
                        onChange={(e) => {
                          const raw = e.target.value;
                          // Hold the raw string in draft state so the
                          // user can clear the field mid-edit. The
                          // controlled value is the draft when set,
                          // falling back to committed cart quantity.
                          setDraftQty((prev) => ({ ...prev, [it.priceId]: raw }));
                          if (raw === "") return;
                          const n = parseInt(raw, 10);
                          if (Number.isFinite(n)) {
                            setQuantity(it.priceId, n);
                          }
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value;
                          if (raw === "") {
                            setQuantity(it.priceId, 1);
                          }
                          // Clear draft so display re-syncs with committed
                          // cart quantity after the user finishes editing.
                          setDraftQty((prev) => {
                            const next = { ...prev };
                            delete next[it.priceId];
                            return next;
                          });
                        }}
                        onFocus={(e) => e.target.select()}
                        className="w-10 h-7 text-sm tabular-nums text-center bg-transparent border-0 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-gold))]/40 rounded"
                        aria-label={`Quantity of ${it.name}`}
                        data-testid={`cart-qty-${it.priceId}`}
                      />
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
                    {/*
                      Save-for-later affordance. Adds the SKU to
                      the localStorage wishlist (no-op if it's
                      already saved) and removes the line from
                      the cart in one click. Sits between the
                      qty stepper and the destructive Remove so
                      shoppers who are decluttering their cart
                      have a non-destructive option.
                    */}
                    <button
                      type="button"
                      onClick={() => handleSaveForLater(it)}
                      className="text-xs text-muted-foreground hover:text-[hsl(var(--penn-navy))] flex items-center gap-1.5 transition-colors"
                      data-testid={`cart-save-for-later-${it.priceId}`}
                    >
                      <Heart className="w-3.5 h-3.5" /> Save for later
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(it)}
                      className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1.5 transition-colors"
                      data-testid={`cart-remove-${it.priceId}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  </div>
                  {it.recurringPriceId && (
                    <div
                      className="mt-3 inline-flex items-center rounded-lg border border-border/60 overflow-hidden bg-secondary/20"
                      role="radiogroup"
                      aria-label={`Choose one-time or subscribe for ${it.name}`}
                      data-testid={`cart-mode-toggle-${it.priceId}`}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={it.mode === "one_time"}
                        onClick={() => setItemMode(it.priceId, "one_time")}
                        className={`px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                          it.mode === "one_time"
                            ? "bg-white text-[hsl(var(--penn-navy))] shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        data-testid={`cart-mode-onetime-${it.priceId}`}
                      >
                        One-time
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={it.mode === "subscription"}
                        onClick={() => setItemMode(it.priceId, "subscription")}
                        className={`px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                          it.mode === "subscription"
                            ? "bg-white text-[hsl(var(--penn-navy))] shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        data-testid={`cart-mode-subscribe-${it.priceId}`}
                      >
                        Subscribe
                      </button>
                    </div>
                  )}
                  {it.mode === "subscription" && it.recurringIntervalLabel && (
                    <p
                      className="text-[11px] text-[hsl(var(--penn-navy))]/75 mt-1.5"
                      data-testid={`cart-mode-cadence-${it.priceId}`}
                    >
                      Auto-ships every {it.recurringIntervalLabel}.
                    </p>
                  )}
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
                  <dd className="text-muted-foreground">
                    Calculated by Stripe
                  </dd>
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
              {/*
                HSA/FSA reminder near the total — every CPAP supply
                in this storefront is IRS-classified as a qualified
                medical expense. Surfacing the badge here (instead of
                only on per-product cards) reassures shoppers right
                before checkout that the HSA/FSA card they're about
                to use is the correct payment method.
              */}
              <div className="mb-4">
                <HsaFsaBadge size="pdp" label="Pay with HSA / FSA card" />
              </div>
              {/*
                Same shipping promise the customer saw on the PDP,
                rendered here so they don't lose confidence between
                product page and checkout. Self-hides if there are no
                items (the parent ternary already guards), and
                gracefully renders even if the catalog is still
                loading — the dates are computed locally.
              */}
              <ShippingEta className="mb-4" testIdPrefix="cart-shipping-eta" />
              <CostTransparencyCallout
                subtotalCents={totalCents}
                className="mb-4"
                testId="cart-cost-transparency"
              />
              <ComfortGuarantee variant="badge" className="mb-4" />
              {error && (
                <div
                  className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 mb-3 flex items-start gap-2"
                  data-testid="cart-error"
                  role="alert"
                >
                  <Info className="w-4 h-4 mt-0.5 shrink-0 text-rose-700" />
                  <div className="flex-1 min-w-0">
                    {/*
                      Detect the Stripe-session-expired family of errors
                      (the customer left the Stripe tab open too long
                      and came back to retry). Show a friendlier "your
                      previous checkout window expired" message + an
                      explicit Try again button so they don't have to
                      hunt for the Checkout button below. For any other
                      error, surface the original message verbatim.
                    */}
                    {/expired|session.*not.*found|410|timed? ?out/i.test(
                      error,
                    ) ? (
                      <>
                        <p className="text-sm font-semibold text-rose-800">
                          Your previous checkout window expired.
                        </p>
                        <p className="text-xs text-rose-700 mt-0.5 leading-relaxed">
                          Stripe checkout pages time out after about 24 hours.
                          Your cart is still here — just tap Try again to start
                          a fresh checkout.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-rose-800">{error}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        void handleCheckout();
                      }}
                      disabled={checkingOut || probing || previewMode === true}
                      className="mt-2 text-xs font-semibold underline text-rose-800 hover:text-rose-900 disabled:opacity-50 disabled:no-underline inline-flex items-center gap-1"
                      data-testid="cart-error-retry"
                    >
                      <RefreshCw className="w-3 h-3" /> Try again
                    </button>
                  </div>
                </div>
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
                        Express checkout — pay with {savedCard?.brand ??
                          "card"}{" "}
                        ••••{savedCard?.last4}
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
                  href="/consent"
                  className="text-xs text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-1.5"
                  data-testid="cart-insurance-link"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Have insurance? Use it for $0 →
                </Link>
              </div>
            </div>
          </aside>
          {/*
            Cross-sell strip lives outside the items column so it
            spans the full width below both columns on desktop. The
            component self-hides when fewer than 2 cards qualify, so
            an empty catalog (preview / fetch failure) won't leave a
            lonely heading visible.
          */}
          <div className="lg:col-span-3">
            <CartCrossSell
              products={catalog}
              cartProductIds={items.map((i) => i.productId)}
              cartCategories={Array.from(
                new Set(
                  items
                    .map(
                      (i) =>
                        catalog.find((p) => p.id === i.productId)?.category,
                    )
                    .filter(
                      (c): c is ShopProductView["category"] =>
                        typeof c === "string",
                    ),
                ),
              )}
            />
          </div>
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
        Browse cushions, tubing, filters, and curated bundles, or skip the cash
        flow entirely and use your insurance.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link href="/shop">
          <Button data-testid="cart-empty-shop">
            Browse the shop <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </Link>
        <Link href="/insurance">
          <Button variant="outline" data-testid="cart-empty-insurance">
            See how insurance works
          </Button>
        </Link>
      </div>
    </div>
  );
}
