// MiniCart — header cart icon that opens a popover with the
// current cart contents instead of navigating away. Replaces the
// previous CartNavIcon which was a plain link to /shop/cart.
//
// Why a popover (not a sheet/drawer) on mobile too:
//   The header is dense and we want the cart icon to give a
//   single, predictable surface across breakpoints. Radix Popover
//   handles small viewports well — content is capped at max-w-sm
//   and the list scrolls — so we avoid maintaining two UIs.
//
// Why we keep BOTH "View cart" and "Checkout" CTAs:
//   The actual Stripe Checkout handoff lives on /shop/cart (see
//   shop-cart.tsx) because that page owns previewMode probing,
//   express-checkout, error retry, etc. So both CTAs land on
//   /shop/cart for now — the primary one is named Checkout to
//   match the customer's mental model. If we later add an
//   in-popover Stripe call we just swap that handler in.

import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight, ShoppingBag, ShoppingCart, Trash2 } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useCart } from "@/hooks/use-cart";
import { formatMoneyCents } from "@/lib/shop-api";

// Soft cap on how many line items we render before introducing a
// scroll. Above this, the popover starts feeling like a real cart
// page, which is the opposite of the affordance we're going for.
const MAX_VISIBLE_ROWS = 4;

export function MiniCart() {
  const { items, count, totalCents, removeItem } = useCart();
  const hasItems = count > 0;
  const [open, setOpen] = useState(false);
  const [location] = useLocation();

  // Auto-close on route change. Otherwise clicking "View cart"
  // navigates to /shop/cart with the popover still open and
  // visually overlapping the cart page header.
  useEffect(() => {
    setOpen(false);
  }, [location]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`relative inline-flex items-center justify-center h-10 w-10 rounded-lg transition-colors ${
            hasItems
              ? "text-[hsl(var(--penn-navy))] hover:bg-secondary/40"
              : "text-muted-foreground hover:text-primary hover:bg-secondary/40"
          }`}
          aria-label={`Cart (${count} item${count === 1 ? "" : "s"})`}
          data-testid="nav-cart-icon"
        >
          <ShoppingCart className="h-5 w-5" strokeWidth={hasItems ? 2.25 : 2} />
          {hasItems && (
            <span
              className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1.5 rounded-full bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))] text-[11px] font-bold leading-none flex items-center justify-center tabular-nums ring-2 ring-white shadow-sm"
              data-testid="nav-cart-count"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[22rem] max-w-[calc(100vw-1.5rem)] p-0 overflow-hidden"
        data-testid="mini-cart-popover"
      >
        {!hasItems ? (
          <div className="p-6 text-center" data-testid="mini-cart-empty">
            <div className="flex justify-center mb-3">
              <div className="h-10 w-10 rounded-xl icon-halo-navy flex items-center justify-center">
                <ShoppingBag className="w-5 h-5" />
              </div>
            </div>
            <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
              Your cart is empty.
            </p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              Cushions, tubing, filters, and curated bundles are a tap away.
            </p>
            <Link href="/shop" data-testid="mini-cart-browse">
              <Button size="sm" className="w-full">
                Browse the shop <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
              </Button>
            </Link>
          </div>
        ) : (
          <>
            <div className="px-4 pt-3 pb-2 border-b border-border/40">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                  Your cart
                </h3>
                <span
                  className="text-xs text-muted-foreground tabular-nums"
                  data-testid="mini-cart-count"
                >
                  {count} item{count === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            <ul
              className="divide-y divide-border/40 max-h-[19rem] overflow-y-auto"
              // Visible-row cap is implicit: each row is ~4.75rem,
              // so max-h ≈ 4 * 4.75rem with the 5th starting to
              // peek. Scrollbar takes over from there.
              style={{
                // Hint to keep scrollbar visible on macOS where it
                // otherwise auto-hides and the user might miss that
                // there are more items below the fold.
                scrollbarGutter: "stable",
              }}
            >
              {items.map((item) => (
                <li
                  key={item.priceId}
                  className="flex items-start gap-3 px-4 py-3"
                  data-testid={`mini-cart-row-${item.priceId}`}
                >
                  <div className="w-12 h-12 shrink-0 rounded-md bg-secondary/40 overflow-hidden flex items-center justify-center">
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <ShoppingBag className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-xs font-semibold text-[hsl(var(--penn-navy))] line-clamp-2 leading-snug"
                      title={item.name}
                    >
                      {item.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
                      <span className="tabular-nums">Qty {item.quantity}</span>
                      {item.mode === "subscription" &&
                        item.recurringIntervalLabel && (
                          <span className="inline-flex items-center px-1.5 rounded bg-[hsl(var(--penn-gold))]/15 text-[hsl(var(--penn-navy))] font-semibold uppercase tracking-wide text-[9px]">
                            {item.recurringIntervalLabel}
                          </span>
                        )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <div className="text-xs font-bold text-[hsl(var(--penn-navy))] tabular-nums">
                      {formatMoneyCents(
                        item.unitAmountCents * item.quantity,
                        item.currency,
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(item.priceId)}
                      className="text-muted-foreground hover:text-rose-700 transition-colors"
                      aria-label={`Remove ${item.name}`}
                      data-testid={`mini-cart-remove-${item.priceId}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {items.length > MAX_VISIBLE_ROWS && (
              <div className="px-4 py-1.5 text-[11px] text-muted-foreground bg-secondary/30 text-center">
                Scroll to see all {items.length} items
              </div>
            )}
            <div className="px-4 py-3 border-t border-border/40 bg-white">
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                  Subtotal
                </span>
                <span
                  className="text-base font-bold text-[hsl(var(--penn-navy))] tabular-nums"
                  data-testid="mini-cart-subtotal"
                >
                  {formatMoneyCents(totalCents)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Link href="/shop/cart" data-testid="mini-cart-view-cart">
                  <Button variant="outline" size="sm" className="w-full">
                    View cart
                  </Button>
                </Link>
                <Link href="/shop/cart" data-testid="mini-cart-checkout">
                  <Button size="sm" className="w-full">
                    Checkout
                  </Button>
                </Link>
              </div>
              <p className="mt-2 text-[10.5px] text-muted-foreground text-center">
                Shipping calculated at checkout
              </p>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
