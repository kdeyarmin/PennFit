// CompareTray — fixed-bottom drawer that appears on /shop once
// the shopper has marked at least one product for comparison.
// Shows mini thumbnails of every selected product (with a small
// X to drop one), the count, a "Clear all" link, and a primary
// "Compare" button that opens the side-by-side dialog.
//
// The dialog renders a spec grid: thumbnail, name, manufacturer,
// model number, price, category, replacement hint, in-stock
// chip, and a CTA row (View details). Up to four columns on
// desktop; stacks to one column per card on mobile so each
// product's row is still readable.
//
// Catalog source: this component receives the full catalog as a
// prop instead of fetching its own copy. The /shop page already
// has the catalog in memory; passing it down avoids a duplicate
// network call and keeps prices/stock perfectly in sync with the
// cards the shopper just clicked from.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Scale, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCompare } from "@/lib/compare";
import {
  formatMoneyCents,
  resolveProductImage,
  type ShopProductView,
} from "@/lib/shop-api";

interface Props {
  catalog: ShopProductView[];
}

const CATEGORY_LABEL: Record<ShopProductView["category"], string> = {
  mask: "Mask",
  cushion: "Cushion",
  tubing: "Tubing",
  filter: "Filter",
  headgear: "Headgear",
  chamber: "Humidifier chamber",
  accessory: "Accessory",
  bundle: "Bundle",
};

export function CompareTray({ catalog }: Props) {
  const { ids, count, remove, clear } = useCompare();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Resolve IDs to live catalog entries, preserving the order
  // the shopper added them (left-to-right in the tray and the
  // dialog matches the order of "click order").
  const items = useMemo(() => {
    const byId = new Map(catalog.map((p) => [p.id, p]));
    return ids
      .map((id) => byId.get(id))
      .filter((p): p is ShopProductView => Boolean(p));
  }, [catalog, ids]);

  if (count === 0) return null;

  return (
    <>
      <div
        className="fixed bottom-4 inset-x-3 md:inset-x-auto md:right-6 md:left-auto md:bottom-6 z-40"
        data-testid="compare-tray"
      >
        <div className="mx-auto md:mx-0 max-w-3xl rounded-2xl bg-[hsl(var(--penn-navy))] text-white shadow-2xl border border-white/10 px-4 py-3 flex items-center gap-3">
          <div className="shrink-0 inline-flex items-center gap-2 text-sm font-semibold">
            <Scale className="w-4 h-4 text-[hsl(var(--penn-gold))]" />
            <span>Compare ({count})</span>
          </div>
          <div className="flex-1 min-w-0 flex gap-2 overflow-x-auto">
            {items.map((p) => {
              const img = resolveProductImage(p.imageUrl);
              return (
                <div
                  key={p.id}
                  className="shrink-0 relative h-12 w-12 rounded-lg bg-white border border-white/20 flex items-center justify-center overflow-hidden"
                  title={p.name}
                  data-testid={`compare-tray-item-${p.id}`}
                >
                  {img ? (
                    <img
                      src={img}
                      alt={p.name}
                      className="w-full h-full object-contain p-1"
                    />
                  ) : (
                    <Scale className="w-4 h-4 text-[hsl(var(--penn-navy))]/50" />
                  )}
                  <button
                    type="button"
                    onClick={() => remove(p.id)}
                    aria-label={`Remove ${p.name} from compare`}
                    className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-white text-[hsl(var(--penn-navy))] inline-flex items-center justify-center shadow ring-1 ring-black/5 hover:bg-red-50 hover:text-red-600 transition-colors"
                    data-testid={`compare-tray-remove-${p.id}`}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <button
              type="button"
              onClick={clear}
              className="hidden sm:inline text-xs text-white/70 hover:text-white underline-offset-2 hover:underline"
              data-testid="compare-tray-clear"
            >
              Clear
            </button>
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              disabled={count < 2}
              className="bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-gold))]/90 font-semibold"
              data-testid="compare-tray-open"
            >
              Compare
              <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
            </Button>
          </div>
        </div>
      </div>
      <CompareDialog
        items={items}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}

interface DialogProps {
  items: ShopProductView[];
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function CompareDialog({ items, open, onOpenChange }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl p-0 overflow-hidden"
        data-testid="compare-dialog"
      >
        <DialogHeader className="px-6 pt-6 pb-3 border-b border-border/60">
          <DialogTitle className="text-xl font-bold tracking-tight text-[hsl(var(--penn-navy))]">
            Side-by-side comparison
          </DialogTitle>
          <DialogDescription>
            {items.length} item{items.length === 1 ? "" : "s"} — review the
            specs and add the one that fits your needs to the cart.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto max-h-[75vh]">
          <div
            className="grid gap-4 p-6"
            style={{
              // 2 cols on small screens (still scrollable horizontally),
              // up to 4 on desktop. Each item gets at least 220px so
              // text doesn't wrap into uselessness.
              gridTemplateColumns: `repeat(${items.length}, minmax(220px, 1fr))`,
              minWidth: `${Math.max(items.length * 240, 560)}px`,
            }}
          >
            {items.map((p) => (
              <CompareCard key={p.id} product={p} />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompareCard({ product }: { product: ShopProductView }) {
  const img = resolveProductImage(product.imageUrl);
  const oneTimeOutOfStock =
    typeof product.stockCount === "number" && product.stockCount <= 0;
  return (
    <div
      className="rounded-xl border border-border/60 bg-white p-4 flex flex-col"
      data-testid={`compare-card-${product.id}`}
    >
      <div className="aspect-square rounded-lg bg-gradient-to-br from-slate-50 via-white to-slate-100 border border-slate-200/60 flex items-center justify-center overflow-hidden">
        {img ? (
          <img
            src={img}
            alt={product.name}
            className="w-full h-full object-contain p-3"
          />
        ) : (
          <Scale className="w-8 h-8 text-[hsl(var(--penn-navy))]/40" />
        )}
      </div>
      <div className="mt-3 flex flex-col flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--penn-navy))]/65">
          {CATEGORY_LABEL[product.category]}
        </p>
        <h3 className="mt-0.5 font-semibold leading-snug text-foreground line-clamp-2">
          {product.name}
        </h3>
        <dl className="mt-3 space-y-2 text-xs">
          <Row label="Brand" value={product.manufacturer ?? "—"} />
          <Row
            label="Model #"
            value={product.modelNumber ? product.modelNumber : "—"}
          />
          <Row
            label="Price"
            value={formatMoneyCents(
              product.price.unitAmount,
              product.price.currency,
            )}
            emphasis
          />
          <Row
            label="Subscription"
            value={
              product.recurringPrice
                ? `Every ${product.recurringPrice.intervalLabel}`
                : "Not available"
            }
          />
          <Row
            label="Replace"
            value={product.replacementHint ?? "Per manufacturer"}
          />
          <Row
            label="Availability"
            value={oneTimeOutOfStock ? "Out of stock" : "In stock"}
            tone={oneTimeOutOfStock ? "warn" : "ok"}
          />
        </dl>
        <div className="mt-auto pt-4">
          <Link href={`/shop/p/${encodeURIComponent(product.id)}`}>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              data-testid={`compare-card-view-${product.id}`}
            >
              View details
              <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-1.5 last:border-b-0">
      <dt className="shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`text-right ${
          emphasis ? "text-base font-bold text-[hsl(var(--penn-navy))]" : ""
        } ${tone === "warn" ? "text-amber-700 font-semibold" : ""} ${
          tone === "ok" ? "text-emerald-700 font-semibold" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
