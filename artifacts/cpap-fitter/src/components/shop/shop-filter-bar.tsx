// ShopFilterBar — sticky filter strip at the top of /shop. Two
// affordances in one bar:
//
//   1. Category jump pills. With 8 categories on the page (bundles,
//      cushions, filters, tubing, headgear, chambers, masks,
//      accessories) the user shouldn't have to scroll a half-screen
//      every time they want to switch shelves. Clicking a pill
//      smooth-scrolls to the matching CategorySection (matched by
//      the existing `id="shop-section-<category>"` anchor on each
//      section). The "All" pill scrolls back to the top of the
//      catalog.
//
//   2. Inline search. Filters across all categories by name +
//      description + manufacturer + model number + tagline. Parent
//      component owns the query state so it can swap the sectioned
//      grid for a flat results grid when the query is non-empty
//      (the pills hide in that mode — "jump to section" doesn't
//      apply when there are no sections).
//
// The bar is sticky-positioned right under the global header
// (top-16 ≈ 4rem header height). On mobile the pill row scrolls
// horizontally so we don't have to wrap onto multiple rows and
// eat vertical space.

import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";

interface Category {
  /** The internal category key, e.g. "filter". */
  value: string;
  /** Human label for the pill, e.g. "Filters". */
  label: string;
}

interface Props {
  query: string;
  onQueryChange: (next: string) => void;
  categories: Category[];
  /** Total visible product count (filtered if query is non-empty). */
  resultCount: number;
}

export function ShopFilterBar({
  query,
  onQueryChange,
  categories,
  resultCount,
}: Props) {
  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;

  const jumpTo = (category: string | null) => {
    if (typeof window === "undefined") return;
    const target = category
      ? document.getElementById(`shop-section-${category}`)
      : document.getElementById("shop-catalog-top");
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div
      className="sticky top-16 z-30 -mx-4 md:-mx-6 px-4 md:px-6 py-3 bg-white/85 backdrop-blur border-b border-border/50"
      data-testid="shop-filter-bar"
    >
      <div className="flex items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search supplies, brands, model numbers…"
            aria-label="Search the shop"
            className="pl-9 pr-9 h-10 bg-white"
            data-testid="shop-search-input"
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
              aria-label="Clear search"
              data-testid="shop-search-clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {isSearching && (
          <span
            className="hidden sm:inline text-xs text-muted-foreground tabular-nums shrink-0"
            data-testid="shop-search-result-count"
            aria-live="polite"
          >
            {resultCount} result{resultCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {!isSearching && categories.length > 0 && (
        <div
          className="mt-2 -mx-1 px-1 flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-thin"
          role="tablist"
          aria-label="Jump to category"
        >
          <button
            type="button"
            onClick={() => jumpTo(null)}
            className="shrink-0 inline-flex items-center px-3 h-7 rounded-full text-xs font-semibold bg-[hsl(var(--penn-navy))] text-white hover:opacity-90 transition-opacity"
            data-testid="shop-jump-all"
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => jumpTo(c.value)}
              className="shrink-0 inline-flex items-center px-3 h-7 rounded-full text-xs font-semibold border border-border/70 bg-white text-[hsl(var(--penn-navy))] hover:border-[hsl(var(--penn-gold))] hover:bg-[hsl(var(--penn-gold))]/5 transition-colors"
              data-testid={`shop-jump-${c.value}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
