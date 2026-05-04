// RecentlyViewedStrip — horizontal carousel of product cards for the
// shopper's recently-viewed SKUs. Hidden when fewer than 2 items
// would be visible (single item is awkward UX, zero is empty).
//
// Renders as a controlled subset of the catalog: the caller passes
// the full ShopProductView[] (already loaded for /shop or fetched
// for the PDP), and we filter+order by the localStorage list.

import { useId, useMemo } from "react";
import { Link } from "wouter";
import { Clock, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  formatMoneyCents,
  resolveProductImage,
  type ShopProductView,
} from "@/lib/shop-api";
import { useRecentlyViewed } from "@/hooks/use-recently-viewed";

interface Props {
  products: ShopProductView[];
  /** Optional id to omit from the strip — used on the PDP to skip
   *  the product the shopper is currently viewing. */
  excludeProductId?: string;
  /** Heading copy override. Defaults to "Recently viewed". */
  heading?: string;
  /** Small variant — used at the bottom of the PDP where the strip
   *  competes with the reviews section for vertical real-estate. */
  compact?: boolean;
}

export function RecentlyViewedStrip({
  products,
  excludeProductId,
  heading = "Recently viewed",
  compact = false,
}: Props) {
  const { productIds, clear } = useRecentlyViewed();
  const headingId = useId();
  // Memoize the ordered list — without this, the entire catalog is
  // walked into a Map + filter + map on every parent re-render
  // (sort/filter clicks on /shop trigger this), which becomes O(N)
  // for nothing. Re-computes only when the inputs actually change.
  const ordered = useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p]));
    return productIds
      .filter((id) => id !== excludeProductId)
      .map((id) => byId.get(id))
      .filter((p): p is ShopProductView => Boolean(p));
  }, [products, productIds, excludeProductId]);

  // < 2 items is awkward UX (just a single card next to a heading).
  // Hide entirely below the threshold.
  if (ordered.length < 2) return null;

  return (
    <section
      data-testid="recently-viewed-strip"
      aria-labelledby={headingId}
      className={`${compact ? "mt-12" : "mt-2"} mb-2`}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 text-base sm:text-lg font-semibold text-[hsl(var(--penn-navy))]"
        >
          <Clock className="w-4 h-4 text-[hsl(var(--penn-gold))]" />
          {heading}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => clear()}
          className="h-7 px-2 text-xs text-muted-foreground"
          data-testid="recently-viewed-clear"
          aria-label="Clear recently viewed"
        >
          <X className="w-3.5 h-3.5 mr-1" /> Clear
        </Button>
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
              data-testid={`recently-viewed-card-${p.id}`}
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
