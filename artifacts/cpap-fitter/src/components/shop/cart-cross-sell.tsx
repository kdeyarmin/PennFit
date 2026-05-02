// CartCrossSell — "Complete your setup" strip rendered on the cart
// page below the line items. The cart is the highest-intent surface
// in the shop, so this is where complementary-category nudges
// (filters, cushions, tubing) have the biggest AOV impact.
//
// Selection rules:
//   * Exclude products already in the cart (same productId).
//   * Exclude bundles — bundles are anchor purchases, not add-ons,
//     and they'd dwarf the strip visually.
//   * Exclude out-of-stock items — an add-to-cart card the user
//     can't actually add is worse than no card at all here.
//   * Prefer categories the cart DOESN'T already cover, then fill
//     from leftover same-category SKUs only if we'd otherwise show
//     fewer than MIN_CARDS items.
//   * Within each bucket, follow the implicit catalog ranking by
//     priority list (consumables first — they're the cheapest add
//     and the most common forgotten item).
//   * Capped at 4 cards so the row stays scannable on desktop and
//     scrolls horizontally on mobile.

import { useId, useMemo } from "react";
import { Link } from "wouter";
import { Sparkles } from "lucide-react";

import {
  formatMoneyCents,
  resolveProductImage,
  type ShopProductView,
} from "@/lib/shop-api";

interface Props {
  products: ShopProductView[];
  cartProductIds: string[];
  cartCategories: string[];
  limit?: number;
}

// Order matters: we surface cheap, frequently-needed consumables
// first since those are the most likely "I forgot to add a..."
// recoveries. Bundles are filtered out separately.
const CATEGORY_PRIORITY: ShopProductView["category"][] = [
  "filter",
  "cushion",
  "tubing",
  "headgear",
  "chamber",
  "mask",
  "accessory",
];

const MIN_CARDS = 2;

export function CartCrossSell({
  products,
  cartProductIds,
  cartCategories,
  limit = 4,
}: Props) {
  const headingId = useId();
  const cards = useMemo(() => {
    const inCartIds = new Set(cartProductIds);
    const inCartCats = new Set(cartCategories);
    const available = products.filter(
      (p) =>
        !inCartIds.has(p.id) &&
        p.category !== "bundle" &&
        !(typeof p.stockCount === "number" && p.stockCount <= 0),
    );
    const priorityOf = (c: ShopProductView["category"]) => {
      const i = CATEGORY_PRIORITY.indexOf(c);
      return i === -1 ? CATEGORY_PRIORITY.length : i;
    };
    // Pass 1: only categories not already represented in the cart.
    const fresh = available
      .filter((p) => !inCartCats.has(p.category))
      .sort((a, b) => priorityOf(a.category) - priorityOf(b.category));
    let picked = fresh.slice(0, limit);
    // Pass 2: if the cart already covers most categories, top up
    // from the same-category leftovers so the strip never collapses
    // to a single lonely card.
    if (picked.length < MIN_CARDS) {
      const pickedIds = new Set(picked.map((p) => p.id));
      const leftover = available
        .filter((p) => !pickedIds.has(p.id))
        .sort((a, b) => priorityOf(a.category) - priorityOf(b.category));
      picked = picked.concat(leftover).slice(0, limit);
    }
    return picked;
  }, [products, cartProductIds, cartCategories, limit]);

  if (cards.length < MIN_CARDS) return null;

  return (
    <section
      data-testid="cart-cross-sell"
      aria-labelledby={headingId}
      className="mt-8"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 text-base sm:text-lg font-semibold text-[hsl(var(--penn-navy))]"
        >
          <Sparkles className="w-4 h-4 text-[hsl(var(--penn-gold))]" />
          Complete your setup
        </h2>
      </div>
      <div
        className="flex gap-3 overflow-x-auto pb-3 -mx-1 px-1 snap-x snap-mandatory scroll-pl-1"
        role="list"
      >
        {cards.map((p) => {
          const img = resolveProductImage(p.imageUrl);
          return (
            <Link
              key={p.id}
              href={`/shop/p/${encodeURIComponent(p.id)}`}
              role="listitem"
              data-testid={`cart-cross-sell-card-${p.id}`}
              className="snap-start shrink-0 w-40 sm:w-44 rounded-xl border border-border/60 bg-white hover:shadow-md hover:border-[hsl(var(--penn-gold))]/40 transition-all overflow-hidden"
            >
              <div className="aspect-square bg-secondary/40 relative">
                {img ? (
                  <img
                    src={img}
                    alt={p.name}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                    No image
                  </div>
                )}
              </div>
              <div className="p-2.5">
                <div
                  className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                  title={p.category}
                >
                  {p.category}
                </div>
                <div
                  className="text-xs font-semibold text-[hsl(var(--penn-navy))] line-clamp-2 mt-0.5"
                  title={p.name}
                >
                  {p.name}
                </div>
                <div className="text-xs font-bold text-[hsl(var(--penn-navy))] mt-1 tabular-nums">
                  {formatMoneyCents(p.price.unitAmount, p.price.currency)}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
