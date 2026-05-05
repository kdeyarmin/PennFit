// /shop/p/:productId — public product detail page for the cash-pay
// shop. Hosts product hero (image + name + price + add-to-cart),
// aggregate rating header, paginated reviews list, and the
// write-review form for signed-in customers.
//
// Data shape:
//   * Product comes from the existing /shop/products list endpoint
//     (catalog is small enough that one round trip wins over an
//     N-product detail endpoint we don't need yet).
//   * Reviews + aggregate come from /shop/products/:id/reviews.
//   * The signed-in caller's own review (any status) comes from
//     /shop/me/reviews/:id. Used to drive "your pending review" /
//     "edit and resubmit" UI.
//
// Auth: review reads work for everyone. Write/edit/delete require a
// session — the page swaps the form for a "Sign in to write a
// review" prompt for signed-out visitors via the auth provider's <Show>.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  Link2,
  Loader2,
  Package,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  Pencil,
  ZoomIn,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useCart } from "@/hooks/use-cart";
import { useRecentlyViewed } from "@/hooks/use-recently-viewed";
import { useToast } from "@/hooks/use-toast";
import { StarRating } from "@/components/star-rating";
import { ComfortGuarantee } from "@/components/comfort-guarantee";
import { CompatibleWithYoursBadge } from "@/components/shop/compatible-with-yours-badge";
import { RecentlyViewedStrip } from "@/components/shop/recently-viewed-strip";
import { YouMayAlsoLikeStrip } from "@/components/shop/you-may-also-like-strip";
import { ShippingEta } from "@/components/shop/shipping-eta";
import { ProductFaq } from "@/components/shop/product-faq";
import { ProductQuestionsSection } from "@/components/shop/product-questions-section";
import { HsaFsaBadge } from "@/components/shop/hsa-fsa-badge";
import { SignedIn, useShopIdentity } from "@/lib/identity";
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  fetchProductReviews,
  fetchShopProducts,
  fetchMyReview,
  submitReview,
  updateMyReview,
  deleteMyReview,
  formatMoneyCents,
  resolveProductImage,
  submitBackInStockNotify,
  type ReviewItem,
  type ReviewListResponse,
  type MyReview,
  type ShopProductView,
} from "@/lib/shop-api";

const BODY_MIN = 20;
const BODY_MAX = 2000;

type LoadState = "loading" | "ready" | "not_found" | "error";

export function ShopProductDetail({ productId }: { productId: string }) {
  const [product, setProduct] = useState<ShopProductView | null>(null);
  // Full catalog kept around so RecentlyViewedStrip can resolve other
  // products by id without firing a second list request.
  const [catalog, setCatalog] = useState<ShopProductView[]>([]);
  const [previewMode, setPreviewMode] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const { recordView } = useRecentlyViewed();

  // Reviews list (paginated) + aggregate. We store the whole
  // ReviewListResponse so the aggregate doesn't go stale on "Show
  // more" loads.
  const [reviewPages, setReviewPages] = useState<ReviewListResponse | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);

  // The signed-in caller's own review for this product, when present.
  const [mine, setMine] = useState<MyReview | null>(null);
  const [mineLoaded, setMineLoaded] = useState(false);

  useDocumentTitle(
    product ? `${product.name} — PennPaps shop` : "Product — PennPaps shop",
    product?.tagline ?? product?.description ?? undefined,
  );

  // OpenGraph + JSON-LD product schema. We compute these together so a
  // single useEffect inside the hook handles both inserts and the
  // unmount cleanup. Memoized on the inputs we actually read so a
  // re-render of unrelated state (e.g. typing in the review form)
  // doesn't re-stringify the JSON-LD payload every keystroke.
  //
  // Aggregate-rating tie-in: only emitted when the public reviews
  // endpoint reports `count > 0` — Google's structured-data validator
  // rejects `aggregateRating` with a zero ratingCount.
  const seoMeta = useMemo(() => {
    if (!product) return { openGraph: null, jsonLd: null };
    const description = (
      product.description ??
      product.tagline ??
      product.name
    ).slice(0, 160);
    const absoluteImage =
      product.imageUrl && /^https?:\/\//i.test(product.imageUrl)
        ? product.imageUrl
        : product.imageUrl
          ? `${window.location.origin}${product.imageUrl.startsWith("/") ? "" : "/"}${product.imageUrl}`
          : undefined;
    const url = `${window.location.origin}/shop/p/${encodeURIComponent(product.id)}`;

    // availability mirrors the in-page UI rule: explicit zero =
    // OutOfStock; null (untracked) or any positive integer = InStock.
    const availability =
      typeof product.stockCount === "number" && product.stockCount <= 0
        ? "https://schema.org/OutOfStock"
        : "https://schema.org/InStock";

    const aggregate = reviewPages?.aggregate;
    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org/",
      "@type": "Product",
      name: product.name,
      description,
      image: absoluteImage,
      brand: product.manufacturer
        ? { "@type": "Brand", name: product.manufacturer }
        : undefined,
      mpn: product.modelNumber ?? undefined,
      offers: {
        "@type": "Offer",
        url,
        priceCurrency: product.price.currency.toUpperCase(),
        price: (product.price.unitAmount / 100).toFixed(2),
        availability,
      },
    };
    if (aggregate && aggregate.count > 0) {
      jsonLd.aggregateRating = {
        "@type": "AggregateRating",
        ratingValue: aggregate.averageRating.toFixed(2),
        reviewCount: aggregate.count,
      };
    }
    return {
      openGraph: {
        title: `${product.name} — Penn Home Medical Supply`,
        description,
        type: "product",
        url,
        siteName: "Penn Home Medical Supply",
        image: absoluteImage,
      } as const,
      jsonLd,
    };
  }, [product, reviewPages?.aggregate]);

  useDocumentMeta({
    openGraph: seoMeta.openGraph,
    jsonLd: seoMeta.jsonLd,
  });

  // Load the product (from the catalog) + its reviews on mount.
  useEffect(() => {
    let active = true;
    setState("loading");
    setErrMsg(null);
    Promise.all([fetchShopProducts(), fetchProductReviews(productId)])
      .then(([catalog, reviews]) => {
        if (!active) return;
        if ("unavailable" in catalog) {
          setState("not_found");
          return;
        }
        const found = catalog.products.find((p) => p.id === productId) ?? null;
        if (!found) {
          setState("not_found");
          return;
        }
        setProduct(found);
        setCatalog(catalog.products);
        setPreviewMode(catalog.previewMode);
        setReviewPages(reviews);
        setState("ready");
        // Track this view AFTER we know the product id resolved to a
        // real catalog row — we don't want to record a view for a
        // 404'd or otherwise-missing id.
        recordView(found.id);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setErrMsg(err instanceof Error ? err.message : String(err));
        setState("error");
      });
    return () => {
      active = false;
    };
    // recordView is stable (useCallback []), but eslint-react-hooks
    // can't see through the hook so we depend on it explicitly.
  }, [productId, recordView]);

  // Load the caller's own review for this product when the auth provider is ready.
  // Refetches on sign-in/out via the user-id key dep below.
  const { isSignedIn, userId } = useShopIdentity();
  const refetchMine = useCallback(() => {
    if (!isSignedIn) {
      setMine(null);
      setMineLoaded(true);
      return;
    }
    fetchMyReview(productId)
      .then((r) => {
        setMine(r);
        setMineLoaded(true);
      })
      .catch(() => {
        // Network / 5xx shouldn't break the page — treat as "no review".
        setMine(null);
        setMineLoaded(true);
      });
  }, [isSignedIn, productId]);
  useEffect(() => {
    setMineLoaded(false);
    refetchMine();
  }, [refetchMine, userId]);

  const handleLoadMore = useCallback(async () => {
    if (!reviewPages?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchProductReviews(productId, {
        cursor: reviewPages.nextCursor,
      });
      setReviewPages((prev) =>
        prev
          ? {
              items: [...prev.items, ...next.items],
              nextCursor: next.nextCursor,
              // Aggregate is identical between pages (filter is
              // status='approved' across the whole product); keep the
              // first page's snapshot to avoid layout jumps if a new
              // approval lands mid-pagination.
              aggregate: prev.aggregate,
            }
          : next,
      );
    } finally {
      setLoadingMore(false);
    }
  }, [productId, reviewPages, loadingMore]);

  if (state === "loading") {
    return (
      <PageShell>
        <PdpSkeleton />
      </PageShell>
    );
  }

  if (state === "not_found") {
    return (
      <PageShell>
        <div className="glass-card rounded-2xl p-10 max-w-xl mx-auto text-center mt-8">
          <h1 className="text-2xl font-bold tracking-tight mb-2">
            We couldn&apos;t find that product.
          </h1>
          <p className="text-sm text-muted-foreground mb-6">
            It may have been retired or replaced. Browse the full catalog and
            we&apos;ll help you find a fresh equivalent.
          </p>
          <Link href="/shop">
            <Button data-testid="pdp-not-found-shop-cta">Back to shop</Button>
          </Link>
        </div>
      </PageShell>
    );
  }

  if (state === "error" || !product || !reviewPages) {
    return (
      <PageShell>
        <div className="glass-card rounded-2xl p-10 max-w-xl mx-auto text-center mt-8">
          <h1 className="text-2xl font-bold tracking-tight mb-2">
            We couldn&apos;t load this product right now.
          </h1>
          <p className="text-xs text-muted-foreground/70 font-mono mt-2">
            {errMsg}
          </p>
          <div className="mt-6">
            <Link href="/shop">
              <Button variant="outline">Back to shop</Button>
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <Hero product={product} previewMode={previewMode} />
      <ProductFaq product={product} />
      <YouMayAlsoLikeStrip products={catalog} currentProduct={product} />
      <RecentlyViewedStrip
        products={catalog}
        excludeProductId={product.id}
        compact
      />
      <ReviewsSection
        productId={productId}
        reviews={reviewPages}
        loadingMore={loadingMore}
        onLoadMore={handleLoadMore}
        mine={mine}
        mineLoaded={mineLoaded}
        onMineChange={(next) => {
          setMine(next);
          setMineLoaded(true);
          // Refetch the public list so a freshly-approved review (or
          // a deletion) is reflected immediately on this page.
          fetchProductReviews(productId)
            .then(setReviewPages)
            .catch(() => {
              // Non-fatal — list will refresh on next mount.
            });
        }}
      />
      <ProductQuestionsSection productId={productId} />
    </PageShell>
  );
}

// Hero product image — always visible as a clickable card; on
// click, opens a lightbox dialog showing the same image at the
// largest size the viewport will allow. This is a frontend-only
// affordance: most product photos are 1024px+ master files and
// look much better full-bleed than scaled into the 480x480
// hero card. Useful for masks/cushions where shoppers want to
// inspect strap routing, vent geometry, or material texture
// before they commit. The Esc key, the X chip, and clicking
// the backdrop all close the lightbox (Radix Dialog defaults).
function ProductImageWithZoom({
  src,
  alt,
  failed,
  onFail,
}: {
  src: string | null;
  alt: string;
  failed: boolean;
  onFail: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasImage = Boolean(src) && !failed;
  return (
    <>
      <button
        type="button"
        onClick={() => hasImage && setOpen(true)}
        disabled={!hasImage}
        aria-label={hasImage ? `View ${alt} full size` : alt}
        className={`group relative aspect-square glass-card rounded-2xl overflow-hidden bg-gradient-to-br from-slate-50 via-white to-slate-100 flex items-center justify-center w-full text-left ${
          hasImage
            ? "cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--penn-gold))]"
            : "cursor-default"
        }`}
        data-testid="pdp-image-zoom-trigger"
      >
        {hasImage ? (
          <img
            src={src ?? undefined}
            alt={alt}
            loading="eager"
            decoding="async"
            onError={onFail}
            className="w-full h-full object-contain p-8 transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <Package className="w-24 h-24 text-[hsl(var(--penn-navy))]/40" />
        )}
        {hasImage && (
          <span
            aria-hidden
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--penn-navy))]/85 text-white text-[11px] font-medium px-2.5 py-1 backdrop-blur-sm opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
          >
            <ZoomIn className="w-3 h-3" />
            Click to zoom
          </span>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-5xl w-[95vw] p-0 bg-transparent border-0 shadow-none"
          data-testid="pdp-image-zoom-dialog"
        >
          {/*
            Visually-hidden header for screen readers. The
            actual visible UI is just the image and the close
            chip; Radix requires DialogTitle/Description to
            avoid an a11y warning, so we render them sr-only.
          */}
          <DialogTitle className="sr-only">{alt} — full size</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size product photo. Press Escape or click outside to close.
          </DialogDescription>
          <div className="relative bg-white rounded-2xl overflow-hidden shadow-2xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close zoom"
              className="absolute top-3 right-3 z-10 h-9 w-9 rounded-full bg-white/95 hover:bg-white text-[hsl(var(--penn-navy))] inline-flex items-center justify-center shadow-md ring-1 ring-black/10"
              data-testid="pdp-image-zoom-close"
            >
              <X className="w-4 h-4" />
            </button>
            {src ? (
              <img
                src={src}
                alt={alt}
                className="w-full max-h-[85vh] object-contain bg-gradient-to-br from-slate-50 via-white to-slate-100"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * PdpSkeleton — reflows to the shape of a real product detail
 * (square hero image on the left, title + tagline + price + CTA on
 * the right). Used while the catalog + reviews are in flight.
 *
 * The previous loading state was a centered spinner; the skeleton
 * keeps the page from looking empty above the fold and means the
 * layout doesn't lurch when data lands.
 */
function PdpSkeleton() {
  return (
    <div
      className="grid md:grid-cols-2 gap-8 md:gap-10 mt-2"
      data-testid="pdp-skeleton"
      role="status"
      aria-label="Loading product"
    >
      <div>
        <Skeleton className="aspect-square w-full rounded-2xl" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-10 w-32 mt-4" />
        <div className="flex gap-3 pt-2">
          <Skeleton className="h-12 flex-1 rounded-full" />
          <Skeleton className="h-12 w-12 rounded-full" />
        </div>
      </div>
      <span className="sr-only">Loading product…</span>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="container mx-auto px-4 md:px-6 py-10 md:py-14 max-w-5xl">
      <Link
        href="/shop"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-[hsl(var(--penn-navy))] transition-colors mb-6"
        data-testid="pdp-back-to-shop"
      >
        <ArrowLeft className="w-4 h-4" /> All products
      </Link>
      {children}
    </div>
  );
}

function Hero({
  product,
  previewMode,
}: {
  product: ShopProductView;
  previewMode: boolean;
}) {
  const { addItem } = useCart();
  const { toast } = useToast();
  const [justAdded, setJustAdded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [mode, setMode] = useState<"one_time" | "subscription">(
    product.recurringPrice ? "subscription" : "one_time",
  );
  const resolved = resolveProductImage(product.imageUrl);

  // Share-by-link affordance. Tries the native Web Share sheet first
  // (iOS Safari, Android Chrome — surfaces Messages, Mail, AirDrop,
  // etc), falls back to clipboard copy with a toast confirmation.
  // Both branches share the same canonical PDP URL — never the page
  // URL, which can carry tracking query params like `?utm_…` we do
  // NOT want to propagate when one shopper passes a link to another.
  async function handleShare() {
    if (typeof window === "undefined") return;
    const basePath = (import.meta.env.BASE_URL || "").replace(/\/$/, "");
    const canonicalBasePath = basePath === "/" ? "" : basePath;
    const url = `${window.location.origin}${canonicalBasePath}/shop/p/${encodeURIComponent(product.id)}`;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: product.name,
          text: product.tagline ?? `${product.name} at PennPaps`,
          url,
        });
        return;
      } catch (err) {
        // User cancelled the share sheet, or share failed silently.
        // We don't surface an error toast for cancellation — fall
        // through to clipboard copy only when the API is missing.
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        // Any other failure: fall through to clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({
        title: "Link copied",
        description: "Product link copied to your clipboard.",
      });
    } catch {
      toast({
        title: "Couldn't copy link",
        description:
          "Your browser blocked clipboard access — long-press the address bar to copy the URL instead.",
        variant: "destructive",
      });
    }
  }

  // Desktop sticky CTA: when the primary Add-to-cart button scrolls
  // out of view, slide a thin bar down from the top with the same
  // CTA. Hidden on mobile because the global mobile-cta-bar already
  // owns the bottom slot there. IntersectionObserver on the button
  // ref is cheaper than scroll listeners and gives us the right
  // toggle semantics for free (only re-fires when state crosses the
  // threshold).
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  const [stickyVisible, setStickyVisible] = useState(false);
  useEffect(() => {
    const el = ctaRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        // Hide while the CTA is on screen; show once it leaves.
        // We trigger when the CTA passes ABOVE the viewport (user
        // scrolled past it). Without this check, the bar would
        // briefly show on initial mount when the page is still
        // settling above the fold.
        if (!entry) return;
        const passedAbove =
          entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0);
        setStickyVisible(!entry.isIntersecting && passedAbove);
      },
      { rootMargin: "0px 0px 0px 0px", threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Inventory affordances. Subscription mode is exempt: the
  // Subscribe & ship toggle stays available even when the one-time
  // pool has hit zero — auto-ship inventory is a separate weekly
  // replenishment pipeline, not the storefront stock count.
  const oneTimeOutOfStock =
    typeof product.stockCount === "number" && product.stockCount <= 0;
  // Per-SKU low-stock threshold (A15). Falls back to the legacy
  // hardcoded 5 when the admin hasn't customized it. A threshold of
  // 0 means "never show the low-stock badge" (admin opt-out).
  const lowThreshold = product.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const lowStockHint =
    typeof product.stockCount === "number" &&
    product.stockCount > 0 &&
    lowThreshold > 0 &&
    product.stockCount <= lowThreshold
      ? product.stockCount
      : null;
  const isSubscriptionMode =
    !!product.recurringPrice && mode === "subscription";
  const addDisabled = previewMode || (!isSubscriptionMode && oneTimeOutOfStock);

  const handleAdd = () => {
    const result = addItem({
      productId: product.id,
      priceId: product.price.id,
      name: product.name,
      unitAmountCents: product.price.unitAmount,
      currency: product.price.currency,
      imageUrl: resolved,
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
    <div
      className="grid grid-cols-1 md:grid-cols-2 gap-8"
      data-testid="pdp-hero"
    >
      <div
        className={`hidden md:block fixed top-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-b border-border shadow-sm transition-transform duration-200 ease-out ${
          stickyVisible ? "translate-y-0" : "-translate-y-full"
        }`}
        aria-hidden={!stickyVisible}
        data-testid="pdp-sticky-cta"
      >
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-4">
          <div className="w-9 h-9 rounded-md bg-secondary/60 overflow-hidden shrink-0 flex items-center justify-center">
            {resolved && !imgFailed ? (
              <img
                src={resolved}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <Package className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="text-sm font-semibold text-[hsl(var(--penn-navy))] truncate"
              title={product.name}
            >
              {product.name}
            </div>
            {product.tagline && (
              <div className="text-xs text-muted-foreground truncate">
                {product.tagline}
              </div>
            )}
          </div>
          <div className="hidden lg:block tabular-nums text-base font-bold text-[hsl(var(--penn-navy))] shrink-0">
            {formatMoneyCents(product.price.unitAmount, product.price.currency)}
          </div>
          <Button
            onClick={handleAdd}
            disabled={addDisabled}
            aria-disabled={addDisabled}
            size="sm"
            className="shrink-0"
            data-testid="pdp-sticky-add-to-cart"
            tabIndex={stickyVisible ? 0 : -1}
          >
            {justAdded ? (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" /> Added
              </>
            ) : !isSubscriptionMode && oneTimeOutOfStock ? (
              "Out of stock"
            ) : (
              <>
                <ShoppingCart className="w-4 h-4 mr-2" />
                {isSubscriptionMode ? "Subscribe" : "Add to cart"}
              </>
            )}
          </Button>
        </div>
      </div>
      <ProductImageWithZoom
        src={resolved}
        alt={product.name}
        failed={imgFailed}
        onFail={() => setImgFailed(true)}
      />

      <div className="flex flex-col">
        {product.isBundle && (
          <Badge
            className="self-start mb-3 bg-[hsl(var(--penn-gold))]/95 text-[hsl(var(--penn-navy))] border-0 font-semibold"
            variant="outline"
          >
            Bundle
          </Badge>
        )}
        <div className="flex items-start gap-3">
          <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight flex-1 min-w-0">
            {product.name}
          </h1>
          <button
            type="button"
            onClick={handleShare}
            className="shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-full border border-border/60 bg-white text-[hsl(var(--penn-navy))] hover:border-[hsl(var(--penn-gold))]/60 hover:bg-[hsl(var(--penn-gold))]/5 transition-colors"
            aria-label={`Share ${product.name}`}
            title="Share this product"
            data-testid="pdp-share"
          >
            <Link2 className="w-4 h-4" />
          </button>
        </div>
        {product.tagline && (
          <p className="text-base text-muted-foreground mt-2">
            {product.tagline}
          </p>
        )}
        {product.description && (
          <p className="text-sm text-foreground/80 leading-relaxed mt-4">
            {product.description}
          </p>
        )}
        <div className="mt-6 flex items-baseline gap-3 flex-wrap">
          <span className="text-4xl font-bold tracking-tight text-[hsl(var(--penn-navy))]">
            {formatMoneyCents(product.price.unitAmount, product.price.currency)}
          </span>
          {oneTimeOutOfStock ? (
            <Badge
              variant="outline"
              className="border-slate-300 text-slate-500 bg-slate-100 font-semibold"
              data-testid="pdp-stock-out"
            >
              Out of stock
            </Badge>
          ) : lowStockHint !== null ? (
            <Badge
              variant="outline"
              className={`font-semibold ${
                lowStockHint <= 3
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : "border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/10 text-[hsl(var(--penn-navy))]"
              }`}
              data-testid="pdp-stock-low"
            >
              Only {lowStockHint} left
            </Badge>
          ) : null}
          <HsaFsaBadge size="pdp" />
        </div>
        {product.recurringPrice && (
          <div
            className="mt-5 rounded-xl border border-border/60 p-1 grid grid-cols-2 gap-1 bg-secondary/30 max-w-sm"
            role="radiogroup"
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
              data-testid="pdp-mode-onetime"
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
              data-testid="pdp-mode-subscribe"
            >
              Subscribe & ship
            </button>
          </div>
        )}
        <Button
          ref={ctaRef}
          onClick={handleAdd}
          className="mt-6 max-w-sm"
          disabled={addDisabled}
          aria-disabled={addDisabled}
          data-testid="pdp-add-to-cart"
        >
          {justAdded ? (
            <>
              <CheckCircle2 className="w-4 h-4 mr-2" /> Added to cart
            </>
          ) : !isSubscriptionMode && oneTimeOutOfStock ? (
            <>Out of stock</>
          ) : (
            <>
              <ShoppingCart className="w-4 h-4 mr-2" />{" "}
              {isSubscriptionMode ? "Subscribe & add" : "Add to cart"}
            </>
          )}
        </Button>
        {oneTimeOutOfStock && !isSubscriptionMode && (
          <BackInStockNotify productId={product.id} />
        )}
        {!oneTimeOutOfStock && (
          <ShippingEta
            className="mt-4 max-w-sm"
            testIdPrefix="pdp-shipping-eta"
          />
        )}
        <Link
          href="/insurance"
          className="text-xs text-muted-foreground hover:text-primary transition-colors mt-3 inline-flex items-center gap-1"
        >
          <ShieldCheck className="w-3.5 h-3.5" /> Or use insurance — $0 with
          prescription
        </Link>
        <div className="mt-4 flex flex-wrap gap-2">
          <ComfortGuarantee variant="badge" />
          <CompatibleWithYoursBadge productId={product.id} />
        </div>
      </div>
    </div>
  );
}

// (ShippingEta + its date helpers were extracted to
// ./components/shop/shipping-eta so the cart page can render the
// same promise. Imported at the top of this file.)
//
// Eastern-time ship cutoff (PennPaps warehouse is in PA). Orders
// placed before this clock time on a business day ship same-day; later
// orders or weekend orders ship the next business day. We compute
// everything in America/New_York so the badge is correct for shoppers
// regardless of their browser timezone.

function BackInStockNotify({ productId }: { productId: string }) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — never rendered visibly
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"inserted" | "duplicate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await submitBackInStockNotify({ productId, email });
      // "queued" is what the honeypot path returns; treat like inserted
      // for the patient-facing message (we never tell a bot it tripped).
      setDone(r.status === "duplicate" ? "duplicate" : "inserted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <div
        className="mt-4 max-w-sm rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 flex items-start gap-2"
        data-testid="pdp-bis-success"
        role="status"
      >
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          {done === "duplicate"
            ? "You're already on the list — we'll email you the moment it's back."
            : "Got it — we'll email you when this is back in stock."}
        </span>
      </div>
    );
  }
  return (
    <form
      onSubmit={onSubmit}
      className="mt-4 max-w-sm rounded-xl border border-border/60 bg-secondary/30 p-3"
      data-testid="pdp-bis-form"
      noValidate
    >
      <label
        htmlFor="bis-email"
        className="text-xs font-semibold text-[hsl(var(--penn-navy))] flex items-center gap-1.5"
      >
        <Bell className="w-3.5 h-3.5" /> Email me when back in stock
      </label>
      <div className="mt-2 flex gap-2">
        <Input
          id="bis-email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1"
          data-testid="pdp-bis-email"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={busy || !email}
          aria-disabled={busy || !email}
          data-testid="pdp-bis-submit"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Notify me"}
        </Button>
      </div>
      {/* Honeypot — visually hidden + aria-hidden + tabIndex=-1 so a
          real keyboard or screen-reader user never lands on it.
          Bots fill every input regardless. */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        autoComplete="off"
        tabIndex={-1}
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-10000px",
          width: "1px",
          height: "1px",
          opacity: 0,
        }}
      />
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        One email per signup. We'll never share your address.
      </p>
    </form>
  );
}

function ReviewsSection({
  productId,
  reviews,
  loadingMore,
  onLoadMore,
  mine,
  mineLoaded,
  onMineChange,
}: {
  productId: string;
  reviews: ReviewListResponse;
  loadingMore: boolean;
  onLoadMore: () => void;
  mine: MyReview | null;
  mineLoaded: boolean;
  onMineChange: (next: MyReview | null) => void;
}) {
  return (
    <section className="mt-14" data-testid="pdp-reviews-section">
      <div className="flex items-center justify-between gap-4 mb-6">
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
          Customer reviews
        </h2>
      </div>
      <AggregateBlock aggregate={reviews.aggregate} />
      <div className="mt-10">
        <SignedIn
          fallback={
            <div
              className="glass-card rounded-2xl p-6 mb-8 flex flex-col sm:flex-row items-start sm:items-center gap-4"
              data-testid="pdp-signin-prompt"
            >
              <div>
                <h3 className="font-semibold tracking-tight">
                  Want to write a review?
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Sign in with your PennPaps account to leave one.
                </p>
              </div>
              <Link
                href={`/sign-in?redirect=/shop/p/${encodeURIComponent(productId)}`}
                className="sm:ml-auto"
              >
                <Button variant="outline">Sign in to review</Button>
              </Link>
            </div>
          }
        >
          {mineLoaded ? (
            mine ? (
              <MyReviewPanel
                productId={productId}
                review={mine}
                onChange={onMineChange}
              />
            ) : (
              <WriteReviewForm
                productId={productId}
                onSubmitted={(r) => onMineChange(r)}
              />
            )
          ) : (
            <div className="text-sm text-muted-foreground py-4 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading your review
              status…
            </div>
          )}
        </SignedIn>
      </div>
      <ReviewList items={reviews.items} />
      {reviews.nextCursor && (
        <div className="mt-6 text-center">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="pdp-reviews-load-more"
          >
            {loadingMore ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Show more reviews
          </Button>
        </div>
      )}
    </section>
  );
}

function AggregateBlock({
  aggregate,
}: {
  aggregate: ReviewListResponse["aggregate"];
}) {
  if (aggregate.count === 0) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="pdp-reviews-empty"
      >
        No reviews yet — be the first to share how this works for you.
      </p>
    );
  }
  // Distribution bars (5★ → 1★ from top to bottom). Each bar's width
  // is its share of the total approved reviews.
  const total = aggregate.count;
  const rows: Array<{ star: 1 | 2 | 3 | 4 | 5; n: number }> = [
    { star: 5, n: aggregate.distribution["5"] ?? 0 },
    { star: 4, n: aggregate.distribution["4"] ?? 0 },
    { star: 3, n: aggregate.distribution["3"] ?? 0 },
    { star: 2, n: aggregate.distribution["2"] ?? 0 },
    { star: 1, n: aggregate.distribution["1"] ?? 0 },
  ];
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-[auto,1fr] gap-8 items-start glass-card rounded-2xl p-6 md:p-8"
      data-testid="pdp-reviews-aggregate"
    >
      <div className="text-center md:text-left">
        <div className="text-5xl font-bold text-[hsl(var(--penn-navy))]">
          {aggregate.averageRating.toFixed(1)}
        </div>
        <StarRating
          value={aggregate.averageRating}
          size="lg"
          hideCount
          className="mt-2"
        />
        <p className="text-sm text-muted-foreground mt-2">
          {aggregate.count} {aggregate.count === 1 ? "review" : "reviews"}
        </p>
      </div>
      <div className="space-y-2">
        {rows.map((r) => {
          const pct = total === 0 ? 0 : (r.n / total) * 100;
          return (
            <div key={r.star} className="flex items-center gap-3 text-sm">
              <span className="w-8 text-muted-foreground tabular-nums">
                {r.star}★
              </span>
              <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full bg-[hsl(var(--penn-gold))] rounded-full"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-8 text-right text-muted-foreground tabular-nums">
                {r.n}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReviewList({ items }: { items: ReviewItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-8 space-y-5" data-testid="pdp-reviews-list">
      {items.map((r) => (
        <li
          key={r.id}
          className="glass-card rounded-2xl p-5 md:p-6"
          data-testid={`pdp-review-${r.id}`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <StarRating value={r.rating} size="sm" hideCount />
              {r.title && (
                <h3 className="font-semibold tracking-tight mt-2">{r.title}</h3>
              )}
            </div>
            <div className="text-right text-xs text-muted-foreground shrink-0">
              <div className="font-medium text-foreground/80">
                {r.authorDisplayName}
              </div>
              {/*
                Verified-purchaser pill. Server flag — the client never
                computes it. Soft-gold to match the existing brand
                affordances (cart count, gold underline) and stays
                small so it doesn't compete with the star rating.
              */}
              {r.verifiedPurchaser && (
                <Badge
                  variant="outline"
                  className="mt-1 border-[hsl(var(--penn-gold))]/60 bg-[hsl(var(--penn-gold))]/10 text-[hsl(var(--penn-navy))] font-semibold text-[10px] tracking-wide"
                  data-testid={`pdp-review-verified-${r.id}`}
                >
                  Verified purchaser
                </Badge>
              )}
              <time dateTime={r.createdAt} className="block mt-1">
                {new Date(r.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </div>
          </div>
          <p className="text-sm text-foreground/85 leading-relaxed mt-3 whitespace-pre-wrap">
            {r.body}
          </p>
        </li>
      ))}
    </ul>
  );
}

function MyReviewPanel({
  productId,
  review,
  onChange,
}: {
  productId: string;
  review: MyReview;
  onChange: (next: MyReview | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (editing) {
    return (
      <WriteReviewForm
        productId={productId}
        initial={review}
        onCancel={() => setEditing(false)}
        onSubmitted={(updated) => {
          setEditing(false);
          onChange(updated);
        }}
      />
    );
  }

  const handleDelete = async () => {
    if (!window.confirm("Delete your review? This can't be undone.")) return;
    setDeleting(true);
    try {
      await deleteMyReview(productId);
      onChange(null);
    } catch {
      setDeleting(false);
      window.alert("Couldn't delete your review. Please try again.");
    }
  };

  return (
    <div
      className="glass-card rounded-2xl p-6 mb-8 border-l-4 border-l-[hsl(var(--penn-gold))]"
      data-testid="pdp-my-review-panel"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase font-semibold tracking-wider text-[hsl(var(--penn-navy))]/70">
            Your review
          </p>
          <div className="mt-1 flex items-center gap-3">
            <StarRating value={review.rating} size="md" hideCount />
            <ReviewStatusBadge status={review.status} />
          </div>
          {review.status === "pending" && (
            <p
              className="mt-2 text-xs text-[hsl(var(--penn-navy))]/75 leading-relaxed max-w-md"
              data-testid="pdp-my-review-pending-hint"
            >
              Awaiting moderation — usually within one business day. You can
              still edit or delete it until it's approved, and your changes will
              be re-reviewed.
            </p>
          )}
          {review.title && (
            <h3 className="font-semibold tracking-tight mt-3">
              {review.title}
            </h3>
          )}
          <p className="text-sm text-foreground/85 leading-relaxed mt-2 whitespace-pre-wrap">
            {review.body}
          </p>
          {review.status === "rejected" && review.moderationNote && (
            <p
              className="mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3"
              data-testid="pdp-my-review-mod-note"
            >
              <span className="font-semibold">Moderator note:</span>{" "}
              {review.moderationNote}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            data-testid="pdp-my-review-edit"
          >
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            {review.status === "rejected" ? "Edit & resubmit" : "Edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
            data-testid="pdp-my-review-delete"
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReviewStatusBadge({
  status,
}: {
  status: "pending" | "approved" | "rejected";
}) {
  if (status === "approved") {
    return (
      <Badge
        className="bg-emerald-50 text-emerald-700 border-emerald-200"
        variant="outline"
      >
        Live
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge
        className="bg-rose-50 text-rose-700 border-rose-200"
        variant="outline"
      >
        Not approved
      </Badge>
    );
  }
  return (
    <Badge
      className="bg-[hsl(var(--penn-gold))]/15 text-[hsl(var(--penn-navy))] border-[hsl(var(--penn-gold))]/40"
      variant="outline"
      data-testid="pdp-my-review-pending-badge"
    >
      Pending approval
    </Badge>
  );
}

function WriteReviewForm({
  productId,
  initial,
  onSubmitted,
  onCancel,
}: {
  productId: string;
  initial?: MyReview;
  onSubmitted: (review: MyReview) => void;
  onCancel?: () => void;
}) {
  const [rating, setRating] = useState<1 | 2 | 3 | 4 | 5>(initial?.rating ?? 5);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedBodyLen = body.trim().length;
  const canSubmit =
    !submitting && trimmedBodyLen >= BODY_MIN && trimmedBodyLen <= BODY_MAX;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const payload = {
      rating,
      title: title.trim() ? title.trim() : null,
      body: body.trim(),
    };
    try {
      if (initial) {
        const updated = await updateMyReview(productId, payload);
        onSubmitted(updated);
        return;
      }
      const result = await submitReview(productId, payload);
      if (result.ok) {
        onSubmitted(result.review);
        return;
      }
      if (result.ok === false && "alreadyReviewed" in result) {
        // Race: someone (the same user in another tab) already created
        // a review since the page mounted. Refetch to swap into the
        // edit panel.
        const mine = await fetchMyReview(productId);
        if (mine) onSubmitted(mine);
        return;
      }
      setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="glass-card rounded-2xl p-6 mb-8"
      data-testid="pdp-write-review-form"
    >
      <h3 className="font-semibold tracking-tight">
        {initial ? "Edit your review" : "Write a review"}
      </h3>
      <p className="text-xs text-muted-foreground mt-1">
        {initial
          ? "Edits go back through moderation before they show publicly."
          : "Reviews are moderated before they appear on the public shop."}
      </p>
      <div className="mt-4">
        <label className="block text-sm font-medium mb-2">Your rating</label>
        <StarRating
          value={rating}
          interactive
          onChange={setRating}
          size="lg"
          hideCount
          testId="pdp-form-rating"
        />
      </div>
      <div className="mt-4">
        <label className="block text-sm font-medium mb-2" htmlFor="rev-title">
          Title <span className="text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="rev-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          placeholder="e.g. Great seal, comfortable strap"
          data-testid="pdp-form-title"
        />
      </div>
      <div className="mt-4">
        <label className="block text-sm font-medium mb-2" htmlFor="rev-body">
          Your review
        </label>
        <Textarea
          id="rev-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={BODY_MAX}
          rows={6}
          placeholder="Share your honest experience — what you liked, what could be better, who you'd recommend it for."
          data-testid="pdp-form-body"
        />
        <div className="text-xs text-muted-foreground mt-1 flex items-center justify-between">
          <span>
            {trimmedBodyLen < BODY_MIN
              ? `${BODY_MIN - trimmedBodyLen} more character${BODY_MIN - trimmedBodyLen === 1 ? "" : "s"} needed`
              : "Looks good."}
          </span>
          <span>
            {trimmedBodyLen} / {BODY_MAX}
          </span>
        </div>
      </div>
      {error && (
        <p
          className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={!canSubmit}
          data-testid="pdp-form-submit"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : null}
          {initial ? "Save changes" : "Submit review"}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
            data-testid="pdp-form-cancel"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

// Suppress unused-import warning for memo helper — kept for parity
// with surrounding shop pages that use it. Remove on next refactor.
void useMemo;
