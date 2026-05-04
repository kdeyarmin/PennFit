// QuickViewDialog — modal preview for a /shop product card so the
// shopper can read the full description, see the larger image, and
// add to cart without navigating away from the catalog page (and
// losing their scroll position across eight category sections).
// This is the standard "quick view" pattern from Shopify / Amazon /
// every modern apparel storefront — for a CPAP catalog where most
// users browse multiple SKUs before buying, it cuts the cost of
// "I want to peek at this one" from a full page navigation to one
// click.
//
// The dialog is intentionally a thin re-presentation of the data
// already on the card; it does NOT fetch reviews, related products,
// or anything else that would warrant the full PDP. A "View full
// details" link takes the shopper to the real PDP if they want
// more (specs, reviews, FAQ, etc).
//
// State ownership: this component owns its OWN add-to-cart wiring
// (useCart, mode toggle, justAdded confirmation pill) so the
// parent ProductCard doesn't have to thread props through. The
// only thing the parent does is open/close the dialog.

import { useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, Repeat, ShieldCheck, ShoppingCart } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StarRating } from "@/components/star-rating";
import { useCart } from "@/hooks/use-cart";
import {
  formatMoneyCents,
  resolveProductImage,
  type ShopProductView,
} from "@/lib/shop-api";

// Categories that are typically billed through CPAP insurance.
// Mirrors the same set used by the card so the chip placement is
// consistent. Kept inline (not imported) to avoid coupling this
// presentational module back to the page module — small enough
// that a tiny duplication beats a dependency cycle.
const INSURANCE_COVERED_CATEGORIES = new Set<ShopProductView["category"]>([
  "mask",
  "cushion",
  "tubing",
  "filter",
  "headgear",
  "chamber",
]);

interface Props {
  product: ShopProductView;
  aggregate: { count: number; averageRating: number } | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

export function QuickViewDialog({
  product,
  aggregate,
  open,
  onOpenChange,
}: Props) {
  const { addItem } = useCart();
  const [mode, setMode] = useState<"one_time" | "subscription">(
    product.recurringPrice ? "subscription" : "one_time",
  );
  const [justAdded, setJustAdded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const resolvedImage = resolveProductImage(product.imageUrl);
  const oneTimeOutOfStock =
    typeof product.stockCount === "number" && product.stockCount <= 0;
  const isSubscriptionMode =
    !!product.recurringPrice && mode === "subscription";
  const addDisabled = !isSubscriptionMode && oneTimeOutOfStock;

  const modelLineParts: string[] = [];
  if (product.manufacturer) modelLineParts.push(product.manufacturer);
  if (product.modelNumber) modelLineParts.push(`Model #${product.modelNumber}`);
  const modelLine = modelLineParts.join(" · ");

  const handleAdd = () => {
    const result = addItem({
      productId: product.id,
      priceId: product.price.id,
      name: product.name,
      unitAmountCents: product.price.unitAmount,
      currency: product.price.currency,
      imageUrl: resolvedImage,
      isBundle: product.isBundle,
      mode: isSubscriptionMode ? "subscription" : "one_time",
      recurringPriceId: product.recurringPrice?.id ?? null,
      recurringIntervalLabel: product.recurringPrice?.intervalLabel ?? null,
      stockCount: product.stockCount,
    });
    if (!result.ok) return;
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1800);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl p-0 overflow-hidden"
        data-testid={`quick-view-dialog-${product.id}`}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription>
            {product.tagline ?? product.description ?? "Product quick view"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2">
          {/* Image pane — square, gradient backdrop, same visual
              treatment as the card so the modal reads as an
              expansion of the card the user just clicked. */}
          <div className="relative aspect-square bg-gradient-to-br from-slate-50 via-white to-slate-100 border-b md:border-b-0 md:border-r border-slate-200/60 flex items-center justify-center">
            {resolvedImage && !imgFailed ? (
              <img
                src={resolvedImage}
                alt={product.name}
                onError={() => setImgFailed(true)}
                className="w-full h-full object-contain p-8"
                data-testid={`quick-view-image-${product.id}`}
              />
            ) : (
              <div className="w-24 h-24 rounded-2xl icon-halo-navy flex items-center justify-center text-[hsl(var(--penn-navy))]">
                <ShoppingCart className="w-10 h-10" />
              </div>
            )}
            {product.isBundle && (
              <Badge
                className="absolute top-3 left-3 bg-[hsl(var(--penn-gold))]/95 text-[hsl(var(--penn-navy))] border-0 shadow-sm font-semibold"
                variant="outline"
              >
                Bundle
              </Badge>
            )}
          </div>
          {/* Detail pane */}
          <div className="p-6 md:p-7 flex flex-col max-h-[80vh] overflow-y-auto">
            {modelLine && (
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--penn-navy))]/65 mb-1.5">
                {modelLine}
              </p>
            )}
            <h2 className="text-xl md:text-2xl font-bold tracking-tight leading-snug text-[hsl(var(--penn-navy))]">
              {product.name}
            </h2>
            {aggregate && aggregate.count > 0 && (
              <div className="mt-2">
                <StarRating
                  value={aggregate.averageRating}
                  count={aggregate.count}
                  size="sm"
                  testId={`quick-view-rating-${product.id}`}
                />
              </div>
            )}
            {product.tagline && (
              <p className="text-sm text-muted-foreground mt-2">
                {product.tagline}
              </p>
            )}
            {product.description && (
              <p className="text-sm text-foreground/80 leading-relaxed mt-3">
                {product.description}
              </p>
            )}
            <div className="mt-4 flex items-baseline gap-3 flex-wrap">
              <span className="text-3xl font-bold tracking-tight text-[hsl(var(--penn-navy))]">
                {formatMoneyCents(
                  product.price.unitAmount,
                  product.price.currency,
                )}
              </span>
              {oneTimeOutOfStock && (
                <Badge
                  variant="outline"
                  className="border-slate-300 text-slate-500 bg-slate-100 font-semibold"
                >
                  Out of stock
                </Badge>
              )}
            </div>
            {INSURANCE_COVERED_CATEGORIES.has(product.category) && (
              <div className="mt-3 inline-flex items-center gap-1.5 self-start rounded-full border border-[hsl(var(--penn-navy)/0.18)] bg-[hsl(var(--penn-navy)/0.05)] px-2.5 py-1 text-[11px] font-semibold text-[hsl(var(--penn-navy))]">
                <ShieldCheck className="w-3 h-3" />
                Often covered by insurance
              </div>
            )}
            {product.recurringPrice && (
              <div
                className="mt-4 rounded-xl border border-border/60 p-1 grid grid-cols-2 gap-1 bg-secondary/30"
                role="radiogroup"
                aria-label="Choose one-time or subscribe"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "one_time"}
                  onClick={() => setMode("one_time")}
                  className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${
                    mode === "one_time"
                      ? "bg-white text-[hsl(var(--penn-navy))] shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`quick-view-mode-onetime-${product.id}`}
                >
                  One-time
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "subscription"}
                  onClick={() => setMode("subscription")}
                  className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${
                    mode === "subscription"
                      ? "bg-white text-[hsl(var(--penn-navy))] shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`quick-view-mode-subscribe-${product.id}`}
                >
                  Subscribe & ship
                </button>
              </div>
            )}
            {product.recurringPrice && mode === "subscription" && (
              <div className="mt-3 rounded-lg border border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/10 px-3 py-2 flex items-start gap-2">
                <Repeat className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[hsl(var(--penn-navy))]" />
                <p className="text-[11px] text-[hsl(var(--penn-navy))] leading-snug">
                  <span className="font-semibold">
                    Auto-ships every {product.recurringPrice.intervalLabel}.
                  </span>{" "}
                  Skip or cancel anytime from your account.
                </p>
              </div>
            )}
            <div className="mt-5 space-y-2">
              <Button
                onClick={handleAdd}
                className="w-full"
                disabled={addDisabled}
                aria-disabled={addDisabled}
                data-testid={`quick-view-add-${product.id}`}
              >
                {justAdded ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 mr-2" /> Added to cart
                  </>
                ) : addDisabled ? (
                  <>Out of stock</>
                ) : (
                  <>
                    <ShoppingCart className="w-4 h-4 mr-2" />{" "}
                    {isSubscriptionMode ? "Subscribe & add" : "Add to cart"}
                  </>
                )}
              </Button>
              <Link
                href={`/shop/p/${encodeURIComponent(product.id)}`}
                onClick={() => onOpenChange(false)}
                className="block text-center text-sm font-semibold text-[hsl(var(--penn-navy))] underline-offset-2 hover:underline"
                data-testid={`quick-view-details-${product.id}`}
              >
                View full details, reviews, and FAQ →
              </Link>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
