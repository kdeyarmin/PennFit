// /shop — public PennPaps cash-pay catalog.
//
// Coexists with the insurance flow (/consent → /capture → /measure →
// /questionnaire → /results → /order). Each product card surfaces two
// CTAs by design (per user product direction):
//   - "Add to cart" — Stripe Hosted Checkout, charges card directly.
//   - "Use insurance ($0 with prescription)" — sends shoppers into the
//     start of the on-device fitting funnel at /consent, NOT directly
//     to /order which is a guarded route requiring measurements first.
//
// When the resupply-api can't reach Stripe (no STRIPE_SECRET_KEY in
// dev), the shop endpoint returns 503 with `unavailable: true` and we
// render a friendly "shop coming soon" hero instead of an error card.
// That keeps the page presentable in fresh dev environments.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  ArrowRight,
  CheckCircle2,
  Filter as FilterIcon,
  Layers,
  Crown,
  Cable,
  Droplets,
  Sparkles,
  Wind,
  Package,
  Repeat,
  ShieldCheck,
  ShoppingCart,
  Loader2,
  Info,
  RefreshCcw,
  WifiOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  fetchReviewAggregates,
  fetchShopProducts,
  formatMoneyCents,
  resolveProductImage,
  type ShopProductView,
  type ShopProductsResponse,
} from "@/lib/shop-api";
import { useCart } from "@/hooks/use-cart";
import { StarRating } from "@/components/star-rating";
import { RecentlyViewedStrip } from "@/components/shop/recently-viewed-strip";
import { ShopFilterBar } from "@/components/shop/shop-filter-bar";

/** Bulk aggregate map keyed by Stripe productId. Empty until loaded. */
type AggregateMap = Record<string, { count: number; averageRating: number }>;

type Category = ShopProductView["category"];

const CATEGORY_META: Record<
  Category,
  { label: string; description: string; icon: React.ReactNode }
> = {
  bundle: {
    label: "Curated bundles",
    description: "Pre-built kits that match the replacement schedule.",
    icon: <Package className="w-5 h-5" />,
  },
  mask: {
    label: "Masks",
    description: "Complete masks with cushion + headgear included.",
    icon: <Wind className="w-5 h-5" />,
  },
  cushion: {
    label: "Replacement cushions",
    description: "The single highest-impact thing to refresh on time.",
    icon: <Layers className="w-5 h-5" />,
  },
  tubing: {
    label: "Tubing",
    description: "Standard and heated tubing for any modern CPAP.",
    icon: <Cable className="w-5 h-5" />,
  },
  filter: {
    label: "Filters",
    description: "Disposable and reusable filtration.",
    icon: <FilterIcon className="w-5 h-5" />,
  },
  headgear: {
    label: "Headgear & straps",
    description: "Restore tension before you start over-tightening.",
    icon: <Crown className="w-5 h-5" />,
  },
  chamber: {
    label: "Humidifier chambers",
    description: "Mineral-free water chambers for ResMed AirSense.",
    icon: <Droplets className="w-5 h-5" />,
  },
  accessory: {
    label: "Accessories",
    description: "Everyday cleaning and care.",
    icon: <Sparkles className="w-5 h-5" />,
  },
};

// Categories that Medicare and most commercial CPAP benefits cover
// on a defined cadence. We surface "Often covered by insurance" on
// cards in these categories so cash-pay shoppers know they may be
// leaving covered benefit on the table. The badge links the patient
// to /insurance for the full coverage workflow.
//
// Excluded: `accessory` (cleaners, wipes, replacement clips — these
// are always cash-pay) and `bundle` (mixed contents — handled per
// individual line item if the patient breaks out the bundle).
const INSURANCE_COVERED_CATEGORIES: ReadonlySet<Category> = new Set([
  "mask",
  "cushion",
  "tubing",
  "filter",
  "headgear",
  "chamber",
]);

// Section ordering: bundles surface first, then high-cadence small items.
const SECTION_ORDER: Category[] = [
  "bundle",
  "cushion",
  "filter",
  "tubing",
  "headgear",
  "chamber",
  "mask",
  "accessory",
];

export function Shop() {
  useDocumentTitle(
    "Shop CPAP supplies",
    "Shop fresh CPAP cushions, filters, tubing, headgear, and bundles direct from Penn Home Medical Supply. Cash-pay shipping or use insurance for $0 with prescription.",
  );
  const [data, setData] = useState<ShopProductsResponse | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumping `attempt` re-runs the load effect — used by the manual
  // "Try again" button on the error card and by the one-shot
  // automatic retry below. Without this, a transient server hiccup
  // (e.g. a dev workflow restart or a brief proxy blip) leaves the
  // shop stuck on the error state until a full page reload.
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let active = true;
    let autoRetryTimer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);
    setError(null);
    fetchShopProducts()
      .then((r) => {
        if (!active) return;
        if ("unavailable" in r) {
          setUnavailable(r.message);
        } else {
          setData(r);
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message = err instanceof Error ? err.message : String(err);
        // First failure on the very first mount: try once more after a
        // short delay before showing the error card. Catches the most
        // common cause (a dev-server restart or a one-off network blip)
        // without needing the patient to refresh.
        if (attempt === 0) {
          autoRetryTimer = setTimeout(() => {
            if (active) setAttempt(1);
          }, 1200);
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (active && !autoRetryTimer) setLoading(false);
      });
    return () => {
      active = false;
      if (autoRetryTimer) clearTimeout(autoRetryTimer);
    };
  }, [attempt]);

  const sections = useMemo(() => {
    if (!data) return [] as Array<{ category: Category; items: ShopProductView[] }>;
    return SECTION_ORDER.filter((c) => (data.byCategory[c] ?? []).length > 0).map(
      (c) => ({ category: c, items: data.byCategory[c] ?? [] }),
    );
  }, [data]);

  // Search query state. Lives on the parent so the filter bar can
  // mutate it AND the renderer can swap the sectioned grid for a
  // flat results grid when it's non-empty. We match across the
  // fields a shopper is most likely to type into a CPAP search:
  // name, tagline, description, manufacturer, model number,
  // category. Case-insensitive, whitespace-trimmed, no fancy
  // tokenization — the catalog is small enough that substring is
  // the right tool.
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();
  const filteredProducts = useMemo(() => {
    if (!data || trimmedQuery.length === 0) return [];
    return data.products.filter((p) => {
      const haystack = [
        p.name,
        p.tagline ?? "",
        p.description ?? "",
        p.manufacturer ?? "",
        p.modelNumber ?? "",
        p.category,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [data, trimmedQuery]);
  const isSearching = trimmedQuery.length > 0;

  // After products land, fetch aggregate review stats for every visible
  // SKU in a single round trip. We deliberately decouple this from the
  // primary products fetch so a flaky reviews endpoint never blanks
  // the entire storefront — `aggregates` simply stays empty and the
  // cards render with no rating block (the existing zero-state).
  const [aggregates, setAggregates] = useState<AggregateMap>({});
  useEffect(() => {
    if (!data || data.products.length === 0) return;
    let active = true;
    const ids = data.products.map((p) => p.id);
    fetchReviewAggregates(ids)
      .then((r) => {
        if (!active) return;
        setAggregates(r.aggregates);
      })
      .catch(() => {
        // Silent: leave aggregates empty so cards just hide stars.
      });
    return () => {
      active = false;
    };
  }, [data]);

  return (
    <div className="container mx-auto px-4 md:px-6 py-12 md:py-16 max-w-6xl">
      <ShopHero />
      {loading ? (
        <div
          className="flex items-center justify-center py-24 text-muted-foreground"
          data-testid="shop-loading"
        >
          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
          Loading PennPaps shop…
        </div>
      ) : unavailable ? (
        <ShopComingSoon message={unavailable} />
      ) : error ? (
        <ShopLoadError message={error} onRetry={retry} />
      ) : sections.length === 0 ? (
        <ShopComingSoon message="No products are available right now." />
      ) : (
        <>
          {data?.previewMode && <PreviewModeBanner />}
          {/*
            Anchor for the "All" pill in the filter bar so it
            always has somewhere to scroll back to. Sits just
            above the recently-viewed strip rather than at the
            very top of the page so the customer doesn't lose the
            sticky bar itself when they tap All.
          */}
          <div id="shop-catalog-top" />
          <ShopFilterBar
            query={query}
            onQueryChange={setQuery}
            categories={sections.map((s) => ({
              value: s.category,
              label: CATEGORY_META[s.category].label,
            }))}
            resultCount={filteredProducts.length}
          />
          <div className="mt-12">
            <RecentlyViewedStrip products={data?.products ?? []} />
          </div>
          {isSearching ? (
            <section
              className="mt-8"
              aria-label="Search results"
              data-testid="shop-search-results"
            >
              <h2 className="text-xl md:text-2xl font-bold tracking-tight mb-4">
                {filteredProducts.length === 0
                  ? "No matches"
                  : `${filteredProducts.length} result${
                      filteredProducts.length === 1 ? "" : "s"
                    }`}
                <span className="text-muted-foreground font-normal text-base ml-2">
                  for &ldquo;{trimmedQuery}&rdquo;
                </span>
              </h2>
              {filteredProducts.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="shop-search-empty"
                >
                  Try a different word — or{" "}
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    clear the search
                  </button>{" "}
                  to browse all categories.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {filteredProducts.map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      aggregate={aggregates[p.id] ?? null}
                    />
                  ))}
                </div>
              )}
            </section>
          ) : (
            <div className="space-y-16 mt-8">
              {sections.map((s) => (
                <CategorySection
                  key={s.category}
                  category={s.category}
                  items={s.items}
                  aggregates={aggregates}
                />
              ))}
            </div>
          )}
        </>
      )}
      <InsuranceFooter />
    </div>
  );
}

function ShopHero() {
  return (
    <div className="text-center max-w-3xl mx-auto mb-2">
      <div className="flex justify-center mb-5">
        <div className="inline-flex items-center gap-3">
          <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            PennPaps · Shop
          </span>
          <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
        </div>
      </div>
      <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5">
        Get fresh CPAP supplies, fast.
      </h1>
      <p className="text-lg text-muted-foreground leading-relaxed">
        No prescription? No insurance? No problem. Order direct, ship to
        your door. Already covered?{" "}
        <Link
          href="/insurance"
          className="text-primary font-medium underline-offset-4 hover:underline"
        >
          See how insurance works
        </Link>{" "}
        — most patients pay $0 out of pocket.
      </p>
    </div>
  );
}

function CategorySection({
  category,
  items,
  aggregates,
}: {
  category: Category;
  items: ShopProductView[];
  aggregates: AggregateMap;
}) {
  const meta = CATEGORY_META[category];
  return (
    <section
      id={`shop-section-${category}`}
      data-testid={`shop-section-${category}`}
      className="scroll-mt-32"
    >
      <div className="flex items-start gap-4 mb-6">
        <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
          {meta.icon}
        </div>
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
            {meta.label}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{meta.description}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {items.map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            aggregate={aggregates[p.id] ?? null}
          />
        ))}
      </div>
    </section>
  );
}

function ProductCard({
  product,
  aggregate,
}: {
  product: ShopProductView;
  aggregate: { count: number; averageRating: number } | null;
}) {
  const { addItem } = useCart();
  const [justAdded, setJustAdded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  // Per-card mode toggle. We keep this in component state rather than
  // in the cart hook because the user may be browsing multiple
  // products and toggling each one before committing to "Add to cart".
  // Default to "subscription" when a recurring price exists — that's
  // the conversion-optimised default for the consumables that carry
  // one (cushions, filters, tubing, etc). Non-recurring SKUs (masks)
  // always behave as one-time.
  const [mode, setMode] = useState<"one_time" | "subscription">(
    product.recurringPrice ? "subscription" : "one_time",
  );
  const resolvedImage = resolveProductImage(product.imageUrl);

  // One-time purchase is blocked iff Stripe metadata says so AND the
  // shopper is not in subscription mode (auto-ship inventory is
  // managed separately — see use-cart's defense-in-depth comment).
  const oneTimeOutOfStock =
    typeof product.stockCount === "number" && product.stockCount <= 0;
  // Per-SKU low-stock threshold (A15). Falls back to the legacy
  // hardcoded 5 when the admin hasn't customized it. A threshold of
  // 0 means "never show the low-stock badge" (admin opt-out for SKUs
  // where stock anxiety isn't a useful signal).
  const lowThreshold =
    product.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const lowStockHint =
    typeof product.stockCount === "number" &&
    product.stockCount > 0 &&
    lowThreshold > 0 &&
    product.stockCount <= lowThreshold
      ? product.stockCount
      : null;
  const isSubscriptionMode =
    !!product.recurringPrice && mode === "subscription";
  const addDisabled = !isSubscriptionMode && oneTimeOutOfStock;

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
    if (!result.ok) {
      // The button should already be disabled at zero stock, but if
      // an admin flipped inventory while the page was open the cart
      // hook is the last-line check. Render the same pill state.
      return;
    }
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1800);
  };

  // Build the small "ResMed · Model #62932" line. Falls back gracefully
  // if either field is missing so legacy products still render cleanly.
  const modelLineParts: string[] = [];
  if (product.manufacturer) modelLineParts.push(product.manufacturer);
  if (product.modelNumber) modelLineParts.push(`Model #${product.modelNumber}`);
  const modelLine = modelLineParts.join(" · ");

  return (
    <div
      className="glass-card lift-on-hover rounded-2xl overflow-hidden flex flex-col"
      data-testid={`shop-card-${product.id}`}
    >
      <div className="relative aspect-square bg-gradient-to-br from-slate-50 via-white to-slate-100 border-b border-slate-200/60 flex items-center justify-center">
        {resolvedImage && !imgFailed ? (
          <img
            src={resolvedImage}
            alt={product.name}
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-contain p-6"
            data-testid={`shop-image-${product.id}`}
          />
        ) : (
          <div className="w-20 h-20 rounded-2xl icon-halo-navy flex items-center justify-center text-[hsl(var(--penn-navy))]">
            <Package className="w-9 h-9" />
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
      <div className="p-6 flex flex-col flex-1">
        {modelLine && (
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--penn-navy))]/65 mb-1.5">
            {modelLine}
          </p>
        )}
        <Link
          href={`/shop/p/${encodeURIComponent(product.id)}`}
          className="block group"
          data-testid={`shop-card-link-${product.id}`}
        >
          <h3 className="text-lg font-semibold tracking-tight leading-snug group-hover:text-[hsl(var(--penn-navy))] group-hover:underline underline-offset-4 decoration-[hsl(var(--penn-gold))]/60 transition-colors">
            {product.name}
          </h3>
        </Link>
        {aggregate && aggregate.count > 0 && (
          <Link
            href={`/shop/p/${encodeURIComponent(product.id)}`}
            className="mt-2 inline-flex"
            aria-label={`See ${aggregate.count} reviews — ${aggregate.averageRating.toFixed(1)} out of 5 stars`}
          >
            <StarRating
              value={aggregate.averageRating}
              count={aggregate.count}
              size="sm"
              testId={`shop-rating-${product.id}`}
            />
          </Link>
        )}
        {product.tagline && (
          <p className="text-sm text-muted-foreground mt-1">{product.tagline}</p>
        )}
        {product.description && (
          <p className="text-sm text-foreground/70 leading-relaxed mt-3 line-clamp-3">
            {product.description}
          </p>
        )}
        <div className="mt-4 mb-4 flex items-baseline gap-3 flex-wrap">
          <span className="text-3xl font-bold tracking-tight text-[hsl(var(--penn-navy))]">
            {formatMoneyCents(product.price.unitAmount, product.price.currency)}
          </span>
          {/*
            Inventory affordances. We render exactly one of these at a
            time so the price line stays scannable. The "Out of stock"
            chip wins over "Only N left" when N hits 0.
          */}
          {oneTimeOutOfStock ? (
            <Badge
              variant="outline"
              className="border-slate-300 text-slate-500 bg-slate-100 font-semibold"
              data-testid={`shop-stock-out-${product.id}`}
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
              data-testid={`shop-stock-low-${product.id}`}
            >
              Only {lowStockHint} left
            </Badge>
          ) : null}
        </div>
        {product.isBundle && product.bundleContents.length > 0 && (
          <ul className="text-sm text-foreground/80 space-y-1.5 mb-4">
            {product.bundleContents.map((line, i) => (
              <li key={i} className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[hsl(var(--penn-gold))]" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
        {product.replacementHint && (
          <p className="text-xs text-muted-foreground mb-4">
            {product.replacementHint}
          </p>
        )}
        {INSURANCE_COVERED_CATEGORIES.has(product.category) && (
          <Link
            href="/insurance"
            className="mb-4 inline-flex items-center gap-1.5 self-start rounded-full border border-[hsl(var(--penn-navy)/0.18)] bg-[hsl(var(--penn-navy)/0.05)] px-2.5 py-1 text-[11px] font-semibold text-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-navy)/0.10)]"
            data-testid={`shop-insurance-pill-${product.id}`}
          >
            <ShieldCheck className="w-3 h-3" />
            Often covered by insurance
          </Link>
        )}
        {product.recurringPrice && (
          <div
            className="mb-4 rounded-xl border border-border/60 p-1 grid grid-cols-2 gap-1 bg-secondary/30"
            role="radiogroup"
            aria-label="Choose one-time or subscribe"
            data-testid={`shop-mode-toggle-${product.id}`}
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
              data-testid={`shop-mode-onetime-${product.id}`}
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
              data-testid={`shop-mode-subscribe-${product.id}`}
            >
              Subscribe & ship
            </button>
          </div>
        )}
        {product.recurringPrice && mode === "subscription" && (
          <div
            className="rounded-lg border border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/10 px-3 py-2 mb-3 flex items-start gap-2"
            data-testid={`shop-mode-cadence-${product.id}`}
          >
            <Repeat className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[hsl(var(--penn-navy))]" />
            <p className="text-[11px] text-[hsl(var(--penn-navy))] leading-snug">
              <span className="font-semibold">
                Auto-ships every {product.recurringPrice.intervalLabel}.
              </span>{" "}
              Never run out · same price · skip or cancel anytime from
              your account.
            </p>
          </div>
        )}
        {product.recurringPrice && mode !== "subscription" && (
          <p
            className="text-[11px] text-[hsl(var(--penn-navy))]/65 mb-3 leading-snug flex items-center gap-1.5"
            data-testid={`shop-mode-onetime-hint-${product.id}`}
          >
            <Repeat className="w-3 h-3 shrink-0" />
            Or subscribe to auto-ship every{" "}
            {product.recurringPrice.intervalLabel} — same price, cancel
            anytime.
          </p>
        )}
        <div className="mt-auto space-y-2">
          <Button
            onClick={handleAdd}
            className="w-full"
            disabled={addDisabled}
            aria-disabled={addDisabled}
            data-testid={`shop-add-${product.id}`}
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
            href="/consent"
            className="block text-center text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            Or use insurance — $0 with prescription
          </Link>
        </div>
      </div>
    </div>
  );
}

function InsuranceFooter() {
  return (
    <div className="glass-card rounded-2xl p-6 md:p-8 mt-16 flex flex-col md:flex-row items-start md:items-center gap-5">
      <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
        <ShieldCheck className="w-6 h-6" />
      </div>
      <div className="flex-1">
        <h3 className="font-semibold tracking-tight">
          Have insurance? Skip the cash-pay path.
        </h3>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
          Most CPAP supplies are 100% covered on a defined cadence. We
          verify your benefit, file the claim, and ship — typically $0
          out of pocket.
        </p>
      </div>
      <Link href="/insurance">
        <Button
          variant="outline"
          className="whitespace-nowrap"
          data-testid="shop-footer-insurance-cta"
        >
          See how insurance works <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </Link>
    </div>
  );
}

function PreviewModeBanner() {
  return (
    <div
      className="rounded-2xl border border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/10 px-5 py-4 mt-8 flex items-start gap-3"
      data-testid="shop-preview-banner"
      role="status"
    >
      <div className="shrink-0 mt-0.5 text-[hsl(var(--penn-navy))]">
        <Info className="w-5 h-5" />
      </div>
      <div className="text-sm leading-relaxed">
        <p className="font-semibold text-[hsl(var(--penn-navy))]">
          Preview mode — payments not yet enabled
        </p>
        <p className="text-foreground/80 mt-0.5">
          You&apos;re browsing a demo of the PennPaps storefront. Card
          checkout will be enabled as soon as Stripe is connected.{" "}
          <Link
            href="/insurance"
            className="text-primary font-medium underline-offset-4 hover:underline"
          >
            Insurance billing
          </Link>{" "}
          is fully live and {" "}
          <span className="font-medium">$0 with prescription.</span>
        </p>
      </div>
    </div>
  );
}

/**
 * Friendly error card with a one-tap retry. Shown only after the
 * one-shot automatic retry inside <Shop> has also failed — so by the
 * time a patient sees this, the issue is more than a transient blip.
 * The retry button re-runs the fetch in place; we fall back to a
 * full reload only as the last-resort path.
 */
function ShopLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="glass-card rounded-2xl p-8 md:p-10 mt-12 max-w-2xl mx-auto text-center"
      data-testid="shop-error"
      role="alert"
    >
      <div className="flex justify-center mb-4">
        <div className="h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
          <WifiOff className="w-6 h-6" />
        </div>
      </div>
      <h2 className="text-xl font-semibold tracking-tight mb-2">
        We couldn&apos;t load the shop right now.
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mb-6 max-w-md mx-auto">
        It&apos;s usually a quick connection hiccup. Try again — if it
        keeps happening, your insurance order is fully live and you can
        place one in a few minutes.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Button onClick={onRetry} data-testid="shop-error-retry">
          <RefreshCcw className="w-4 h-4 mr-2" />
          Try again
        </Button>
        <Link href="/insurance">
          <Button variant="outline" data-testid="shop-error-insurance">
            See how insurance works
          </Button>
        </Link>
      </div>
      {/* Quietly surface the technical reason for users who care; most
          patients won't, but it helps when they describe the issue to
          our team. */}
      <p className="text-[11px] text-muted-foreground/70 mt-5 font-mono">
        {message}
      </p>
    </div>
  );
}

function ShopComingSoon({ message }: { message: string }) {
  return (
    <div
      className="glass-card rounded-2xl p-10 md:p-14 text-center mt-12 max-w-2xl mx-auto"
      data-testid="shop-coming-soon"
    >
      <div className="flex justify-center mb-4">
        <div className="h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
          <Sparkles className="w-6 h-6" />
        </div>
      </div>
      <h2 className="text-2xl font-bold tracking-tight mb-3">
        The PennPaps shop is opening soon.
      </h2>
      <p className="text-muted-foreground leading-relaxed mb-6">{message}</p>
      <Link href="/consent">
        <Button data-testid="shop-coming-soon-insurance-cta">
          Use insurance now — $0 with prescription{" "}
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </Link>
    </div>
  );
}
