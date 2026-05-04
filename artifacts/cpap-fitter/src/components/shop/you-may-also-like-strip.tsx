// YouMayAlsoLikeStrip — same-category cross-sell carousel for the
// product detail page. Visual twin of RecentlyViewedStrip (so the
// PDP has a consistent feel between the two strips), but populated
// from the catalog by category instead of from localStorage.
//
// Selection rules:
//   * Same `category` as the current product. CPAP shoppers think
//     in categories ("nasal pillows", "filters", "tubing") so this
//     is the highest-signal axis available without a recommender.
//   * Excludes the current product id.
//   * Out-of-stock SKUs are pushed to the end (still visible — the
//     OOS card has the Notify-Me CTA built into the PDP — but they
//     shouldn't crowd out in-stock alternatives).
//   * Capped at 6 items so the row stays scannable on mobile.
//   * Hidden entirely if fewer than 2 candidates remain (a single
//     card next to a heading is awkward UX).

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
  /** The product currently displayed on the PDP. */
  currentProduct: Pick<ShopProductView, "id" | "category">;
  /** Soft cap on how many cards to render. Defaults to 6. */
  limit?: number;
}

const MIN_CARDS = 2;

export function YouMayAlsoLikeStrip({
  products,
  currentProduct,
  limit = 6,
}: Props) {
  const headingId = useId();
  const ordered = useMemo(() => {
    const candidates = products.filter(
      (p) =>
        p.id !== currentProduct.id && p.category === currentProduct.category,
    );
    // Sort: in-stock first (OOS to the back). Within each bucket
    // preserve catalog order — admins curate the /shop list, so we
    // respect that ordering as the implicit ranking.
    candidates.sort((a, b) => {
      const aOos =
        typeof a.stockCount === "number" && a.stockCount <= 0 ? 1 : 0;
      const bOos =
        typeof b.stockCount === "number" && b.stockCount <= 0 ? 1 : 0;
      return aOos - bOos;
    });
    return candidates.slice(0, limit);
  }, [products, currentProduct.id, currentProduct.category, limit]);

  if (ordered.length < MIN_CARDS) return null;

  return (
    <section
      data-testid="you-may-also-like-strip"
      aria-labelledby={headingId}
      className="mt-10 mb-2"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 text-base sm:text-lg font-semibold text-[hsl(var(--penn-navy))]"
        >
          <Sparkles className="w-4 h-4 text-[hsl(var(--penn-gold))]" />
          You may also like
        </h2>
      </div>
      <div
        className="flex gap-3 overflow-x-auto pb-3 -mx-1 px-1 snap-x snap-mandatory scroll-pl-1"
        role="list"
      >
        {ordered.map((p) => {
          const img = resolveProductImage(p.imageUrl);
          const oos = typeof p.stockCount === "number" && p.stockCount <= 0;
          return (
            <Link
              key={p.id}
              href={`/shop/p/${encodeURIComponent(p.id)}`}
              role="listitem"
              data-testid={`you-may-also-like-card-${p.id}`}
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
                {oos && (
                  <div className="absolute inset-x-0 bottom-0 bg-slate-900/70 text-white text-[10px] font-semibold tracking-wide uppercase text-center py-0.5">
                    Out of stock
                  </div>
                )}
              </div>
              <div className="p-2.5">
                <div
                  className="text-xs font-semibold text-[hsl(var(--penn-navy))] line-clamp-2"
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
