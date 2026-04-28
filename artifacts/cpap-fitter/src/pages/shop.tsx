// /shop — public PennPaps cash-pay catalog.
//
// Coexists with the insurance flow (/order). Each product card surfaces
// two CTAs by design (per user product direction):
//   - "Add to cart" — Stripe Hosted Checkout, charges card directly.
//   - "Use insurance ($0 with prescription)" — sends shoppers into the
//     existing /order flow rather than letting them double-pay.
//
// When the resupply-api can't reach Stripe (no STRIPE_SECRET_KEY in
// dev), the shop endpoint returns 503 with `unavailable: true` and we
// render a friendly "shop coming soon" hero instead of an error card.
// That keeps the page presentable in fresh dev environments.

import React, { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
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
  ShieldCheck,
  ShoppingCart,
  Loader2,
  Info,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  fetchShopProducts,
  formatMoneyCents,
  type ShopProductView,
  type ShopProductsResponse,
} from "@/lib/shop-api";
import { useCart } from "@/hooks/use-cart";

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
  const [data, setData] = useState<ShopProductsResponse | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
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
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const sections = useMemo(() => {
    if (!data) return [] as Array<{ category: Category; items: ShopProductView[] }>;
    return SECTION_ORDER.filter((c) => (data.byCategory[c] ?? []).length > 0).map(
      (c) => ({ category: c, items: data.byCategory[c] ?? [] }),
    );
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
        <div
          className="glass-card rounded-2xl p-8 text-center text-muted-foreground"
          data-testid="shop-error"
        >
          <p>We couldn&apos;t load the shop right now. Please refresh.</p>
        </div>
      ) : sections.length === 0 ? (
        <ShopComingSoon message="No products are available right now." />
      ) : (
        <>
          {data?.previewMode && <PreviewModeBanner />}
          <div className="space-y-16 mt-12">
            {sections.map((s) => (
              <CategorySection
                key={s.category}
                category={s.category}
                items={s.items}
              />
            ))}
          </div>
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
        your door. Already covered? Use the{" "}
        <Link
          href="/order"
          className="text-primary font-medium underline-offset-4 hover:underline"
        >
          insurance flow
        </Link>{" "}
        instead — it&apos;s $0 out of pocket.
      </p>
    </div>
  );
}

function CategorySection({
  category,
  items,
}: {
  category: Category;
  items: ShopProductView[];
}) {
  const meta = CATEGORY_META[category];
  return (
    <section data-testid={`shop-section-${category}`}>
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
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </section>
  );
}

function ProductCard({ product }: { product: ShopProductView }) {
  const { addItem } = useCart();
  const [justAdded, setJustAdded] = useState(false);
  const handleAdd = () => {
    addItem({
      productId: product.id,
      priceId: product.price.id,
      name: product.name,
      unitAmountCents: product.price.unitAmount,
      currency: product.price.currency,
      imageUrl: product.imageUrl,
      isBundle: product.isBundle,
    });
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1800);
  };

  return (
    <div
      className="glass-card lift-on-hover rounded-2xl p-6 flex flex-col"
      data-testid={`shop-card-${product.id}`}
    >
      {product.isBundle && (
        <Badge
          className="self-start mb-3 bg-[hsl(var(--penn-gold))]/15 text-[hsl(var(--penn-navy))] border-[hsl(var(--penn-gold))]/30"
          variant="outline"
        >
          Bundle · save vs. à la carte
        </Badge>
      )}
      <h3 className="text-lg font-semibold tracking-tight">{product.name}</h3>
      {product.tagline && (
        <p className="text-sm text-muted-foreground mt-1">{product.tagline}</p>
      )}
      <div className="mt-4 mb-4">
        <span className="text-3xl font-bold tracking-tight text-[hsl(var(--penn-navy))]">
          {formatMoneyCents(product.price.unitAmount, product.price.currency)}
        </span>
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
      <div className="mt-auto space-y-2">
        <Button
          onClick={handleAdd}
          className="w-full"
          data-testid={`shop-add-${product.id}`}
        >
          {justAdded ? (
            <>
              <CheckCircle2 className="w-4 h-4 mr-2" /> Added to cart
            </>
          ) : (
            <>
              <ShoppingCart className="w-4 h-4 mr-2" /> Add to cart
            </>
          )}
        </Button>
        <Link
          href="/order"
          className="block text-center text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          Or use insurance — $0 with prescription
        </Link>
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
      <Link href="/order">
        <Button
          variant="outline"
          className="whitespace-nowrap"
          data-testid="shop-footer-insurance-cta"
        >
          Use insurance instead <ArrowRight className="w-4 h-4 ml-2" />
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
          checkout will be enabled as soon as Stripe is connected. The{" "}
          <Link
            href="/order"
            className="text-primary font-medium underline-offset-4 hover:underline"
          >
            insurance flow
          </Link>{" "}
          is fully live and {" "}
          <span className="font-medium">$0 with prescription.</span>
        </p>
      </div>
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
      <Link href="/order">
        <Button data-testid="shop-coming-soon-insurance-cta">
          Use insurance now — $0 with prescription{" "}
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </Link>
    </div>
  );
}
