import React, { useEffect, useState } from "react";
import { List } from "lucide-react";

type TocItem = {
  /** Heading text — used as the visible label. */
  label: string;
  /** Slug used for the anchor id (`#${slug}`). The article must assign this to its <h2 id>. */
  slug: string;
};

type TableOfContentsProps = {
  items: TocItem[];
  /** Optional title for the ToC card. Defaults to "In this article". */
  title?: string;
  /** Optional `data-testid` prefix. */
  testIdPrefix?: string;
};

/**
 * Table-of-contents sidebar for long-form articles. Renders as a
 * sticky right-rail sidebar on lg+ screens, and as a collapsible
 * card at the top of the article on mobile. Uses IntersectionObserver
 * to highlight the section currently in view.
 *
 * Articles using this should:
 *   1. Wrap the main column at max-w-4xl, and place this component
 *      inside a parent grid that's lg:grid-cols-[1fr_auto] OR
 *      position absolutely.
 *   2. Add an `id={slug}` attribute to each <h2> for which there's a
 *      matching item here.
 */
export function TableOfContents({
  items,
  title = "In this article",
  testIdPrefix = "toc",
}: TableOfContentsProps) {
  const [activeSlug, setActiveSlug] = useState<string | null>(
    items[0]?.slug ?? null,
  );
  const [mobileOpen, setMobileOpen] = useState(false);

  // Watch each anchored section. Mark the topmost one currently
  // intersecting the upper third of the viewport as active.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) {
          setActiveSlug(visible[0].target.id);
        }
      },
      { rootMargin: "-15% 0% -70% 0%", threshold: 0 },
    );
    for (const item of items) {
      const el = document.getElementById(item.slug);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  const links = (
    <ul className="space-y-1" data-testid={`${testIdPrefix}-list`}>
      {items.map((item, idx) => (
        <li key={item.slug}>
          <a
            href={`#${item.slug}`}
            className={`block py-1.5 pl-3 text-xs leading-snug transition-colors border-l-2 ${
              activeSlug === item.slug
                ? "border-[hsl(var(--penn-gold))] text-foreground font-semibold"
                : "border-border/40 text-muted-foreground hover:text-primary hover:border-primary/40"
            }`}
            onClick={() => setMobileOpen(false)}
          >
            <span className="text-[10px] font-mono text-[hsl(var(--penn-gold-deep))] mr-2">
              {String(idx + 1).padStart(2, "0")}
            </span>
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {/* Mobile / md — collapsible card at the top of the article */}
      <details
        className="lg:hidden glass-card rounded-2xl mb-6 group"
        open={mobileOpen}
        onToggle={(e) => setMobileOpen((e.target as HTMLDetailsElement).open)}
        data-testid={`${testIdPrefix}-mobile`}
      >
        <summary className="cursor-pointer list-none flex items-center justify-between gap-3 p-4 select-none">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg flex items-center justify-center icon-halo-navy">
              <List className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {title}
              </div>
              <div className="text-xs text-foreground/85">
                {items.length} sections · tap to expand
              </div>
            </div>
          </div>
          <span className="text-xs text-muted-foreground group-open:rotate-90 transition-transform">
            ›
          </span>
        </summary>
        <div className="px-4 pb-4">{links}</div>
      </details>

      {/* Desktop — sticky right-rail. The article wrapper places it in
          a lg:grid sidebar slot; here we just take the height we need
          and stick to the top of the viewport with comfortable offset. */}
      <aside
        className="hidden lg:block sticky top-24 self-start w-56 shrink-0"
        aria-label="Article navigation"
        data-testid={`${testIdPrefix}-desktop`}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground mb-3 px-3">
          {title}
        </div>
        {links}
      </aside>
    </>
  );
}
