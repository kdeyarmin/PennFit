// Wishlist page — /shop/wishlist. Resolves the localStorage
// product IDs against a fresh catalog fetch so prices and stock
// chips reflect the current state of the world rather than
// whatever the shopper saw when they hearted the item.
//
// Empty state: a friendly nudge back to /shop with a one-line
// explanation of how the heart works. We don't show a fake
// "you might like" carousel here — the catalog itself is one
// click away.
//
// Stale-ID handling: if a saved product ID no longer exists in
// the catalog (admin removed it, or it was archived), we just
// drop it from the rendered list AND from localStorage on
// mount. This keeps the count badge in the header honest.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Heart, Trash2, ShoppingCart, ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import {
  fetchShopProducts,
  formatMoneyCents,
  resolveProductImage,
  type ShopProductView,
} from "@/lib/shop-api";
import { useCart } from "@/hooks/use-cart";
import { addToWishlist, removeFromWishlist, useWishlist } from "@/lib/wishlist";

export function ShopWishlist() {
  const { ids } = useWishlist();
  const { addItem } = useCart();
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<ShopProductView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchShopProducts()
      .then((res) => {
        if (cancelled) return;
        if ("unavailable" in res) {
          // Shop API down — surface as an inline error rather than a
          // crash. The wishlist itself (the list of saved IDs) is
          // still intact in localStorage.
          setError(res.message);
          setCatalog([]);
          return;
        }
        setCatalog(res.products);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Map saved IDs onto live catalog entries, preserving wishlist
  // order (newest first). Saved IDs that no longer match anything
  // in the catalog get pruned from localStorage so they stop
  // counting against the header badge.
  const items = useMemo(() => {
    if (!catalog) return [] as ShopProductView[];
    const byId = new Map(catalog.map((p) => [p.id, p]));
    return ids
      .map((id) => byId.get(id))
      .filter((p): p is ShopProductView => Boolean(p));
  }, [catalog, ids]);

  useEffect(() => {
    if (!catalog) return;
    const liveIds = new Set(catalog.map((p) => p.id));
    const stale = ids.filter((id) => !liveIds.has(id));
    for (const id of stale) removeFromWishlist(id);
  }, [catalog, ids]);

  // In-stock subset — drives both the per-row Add buttons (which
  // already gate on stockCount) and the bulk Move-all action below.
  const inStockItems = useMemo(
    () =>
      items.filter(
        (p) => !(typeof p.stockCount === "number" && p.stockCount <= 0),
      ),
    [items],
  );

  function handleMoveAllToCart() {
    if (inStockItems.length === 0) return;
    let added = 0;
    for (const product of inStockItems) {
      const result = addItem({
        productId: product.id,
        priceId: product.price.id,
        name: product.name,
        unitAmountCents: product.price.unitAmount,
        currency: product.price.currency,
        imageUrl: resolveProductImage(product.imageUrl),
        isBundle: product.isBundle,
        // Bulk Move stays consistent with the per-row Move button —
        // always one-time. Subscriptions remain a per-product opt-in
        // on the PDP (which is the only surface that can show the
        // cadence the shopper is committing to).
        mode: "one_time" as const,
        recurringPriceId: null,
        recurringIntervalLabel: null,
        stockCount: product.stockCount,
      });
      if (result.ok) {
        removeFromWishlist(product.id);
        added += 1;
      }
    }
    toast({
      title: added > 0 ? "Added to cart" : "Nothing added",
      description:
        added > 0
          ? `${added} item${added === 1 ? "" : "s"} moved from your saved list to your cart.`
          : "Items couldn't be added — they may be out of stock.",
    });
  }

  return (
    <div className="container mx-auto px-4 md:px-6 py-10 md:py-14 max-w-5xl">
      <Link
        href="/shop"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors mb-6"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to shop
      </Link>
      <div className="flex items-center gap-3 mb-2">
        <div className="h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center text-[hsl(var(--penn-navy))]">
          <Heart className="w-5 h-5" />
        </div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-[hsl(var(--penn-navy))]">
          Saved for later
        </h1>
      </div>
      <p className="text-sm text-muted-foreground mb-8 max-w-2xl">
        Items you&apos;ve hearted across the shop. Saved on this device only —
        no account required. Remove an item with the trash icon, or jump
        straight to its detail page.
      </p>

      {loading ? (
        <div
          className="text-sm text-muted-foreground"
          data-testid="wishlist-loading"
        >
          Loading your saved items…
        </div>
      ) : error ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          data-testid="wishlist-error"
        >
          We couldn&apos;t load your wishlist: {error}
        </div>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Bulk-action toolbar — only renders when at least one
              in-stock item is present. Hidden in the all-out-of-stock
              edge case so the button isn't permanently disabled. */}
          {inStockItems.length > 0 && (
            <div
              className="mb-4 flex items-center justify-between flex-wrap gap-3"
              data-testid="wishlist-bulk-toolbar"
            >
              <div className="text-sm text-muted-foreground">
                {items.length} saved
                {inStockItems.length !== items.length && (
                  <>
                    {" "}
                    ·{" "}
                    <span className="text-amber-700">
                      {items.length - inStockItems.length} out of stock
                    </span>
                  </>
                )}
              </div>
              <Button
                size="sm"
                onClick={handleMoveAllToCart}
                data-testid="wishlist-move-all"
              >
                <ShoppingCart className="w-3.5 h-3.5 mr-1.5" />
                Move{" "}
                {inStockItems.length === items.length
                  ? "all"
                  : "in-stock items"}{" "}
                to cart
              </Button>
            </div>
          )}
          <div
            className="grid grid-cols-1 md:grid-cols-2 gap-5"
            data-testid="wishlist-grid"
          >
            {items.map((p) => (
              <WishlistRow key={p.id} product={p} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded-2xl border border-dashed border-border/70 bg-white/60 backdrop-blur-sm px-6 py-12 text-center"
      data-testid="wishlist-empty"
    >
      <div className="mx-auto h-12 w-12 rounded-2xl icon-halo-navy flex items-center justify-center text-[hsl(var(--penn-navy))] mb-4">
        <Heart className="w-5 h-5" />
      </div>
      <h2 className="text-lg font-semibold text-foreground">
        Nothing saved yet
      </h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
        Tap the heart on any product in the shop to save it here. Useful for
        comparing a couple of cushions or masks before you commit.
      </p>
      <div className="mt-5">
        <Link href="/shop">
          <Button variant="outline">Browse the shop</Button>
        </Link>
      </div>
    </div>
  );
}

function WishlistRow({ product }: { product: ShopProductView }) {
  const { addItem } = useCart();
  const { toast } = useToast();
  const resolved = resolveProductImage(product.imageUrl);
  const oneTimeOutOfStock =
    typeof product.stockCount === "number" && product.stockCount <= 0;

  const buildLine = () => ({
    productId: product.id,
    priceId: product.price.id,
    name: product.name,
    unitAmountCents: product.price.unitAmount,
    currency: product.price.currency,
    imageUrl: resolved,
    isBundle: product.isBundle,
    // Wishlist always adds as a one-time purchase. The recurring
    // toggle is a per-card decision; if the shopper wants the
    // subscription cadence they should click through to the PDP.
    mode: "one_time" as const,
    recurringPriceId: null,
    recurringIntervalLabel: null,
    stockCount: product.stockCount,
  });

  const handleAdd = () => {
    addItem(buildLine());
  };

  // "Move to cart" — symmetric counterpart to the cart page's
  // "Save for later". Adds to cart and removes from the wishlist
  // in one click so the saved list stays a meaningful shortlist
  // instead of accumulating items the shopper has already moved
  // forward on.
  const handleMove = () => {
    addItem(buildLine());
    removeFromWishlist(product.id);
  };

  return (
    <div
      className="glass-card rounded-2xl p-4 flex gap-4 items-start"
      data-testid={`wishlist-row-${product.id}`}
    >
      <Link
        href={`/shop/p/${encodeURIComponent(product.id)}`}
        className="shrink-0 h-24 w-24 rounded-xl bg-gradient-to-br from-slate-50 via-white to-slate-100 border border-slate-200/60 flex items-center justify-center overflow-hidden"
      >
        {resolved ? (
          <img
            src={resolved}
            alt={product.name}
            className="w-full h-full object-contain p-2"
          />
        ) : (
          <ShoppingCart className="w-7 h-7 text-[hsl(var(--penn-navy))]/60" />
        )}
      </Link>
      <div className="flex-1 min-w-0">
        <Link
          href={`/shop/p/${encodeURIComponent(product.id)}`}
          className="block group"
        >
          <h3 className="font-semibold tracking-tight leading-snug group-hover:text-[hsl(var(--penn-navy))] group-hover:underline underline-offset-4 decoration-[hsl(var(--penn-gold))]/60 transition-colors">
            {product.name}
          </h3>
        </Link>
        {product.tagline && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {product.tagline}
          </p>
        )}
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          <span className="text-lg font-bold text-[hsl(var(--penn-navy))]">
            {formatMoneyCents(product.price.unitAmount, product.price.currency)}
          </span>
          {oneTimeOutOfStock && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Out of stock
            </span>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={oneTimeOutOfStock}
            data-testid={`wishlist-add-${product.id}`}
          >
            <ShoppingCart className="w-3.5 h-3.5 mr-1.5" />
            Add to cart
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleMove}
            disabled={oneTimeOutOfStock}
            data-testid={`wishlist-move-${product.id}`}
            title="Add to cart and remove from your saved list"
          >
            Move to cart
          </Button>
          <button
            type="button"
            onClick={() => {
              removeFromWishlist(product.id);
              toast({
                title: "Removed from saved items",
                description: `“${product.name}” removed.`,
                action: (
                  <ToastAction
                    altText={`Undo removing ${product.name}`}
                    onClick={() => addToWishlist(product.id)}
                  >
                    Undo
                  </ToastAction>
                ),
              });
            }}
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border/60 text-muted-foreground hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
            aria-label={`Remove ${product.name} from wishlist`}
            data-testid={`wishlist-remove-${product.id}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
