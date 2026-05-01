import { ExternalLink } from "lucide-react";

/**
 * ConsoleSwitcher — top-of-sidebar block that lets operators jump
 * between the two admin surfaces:
 *
 *   - Resupply CRM (this app, mounted at /resupply): patient roster,
 *     unified inbox, rules engine, shop inventory/reviews.
 *   - Shop & Fittings (the cpap-fitter admin, mounted at /admin):
 *     new-order intake from the virtual mask fitter, reminders.
 *
 * Cross-console links are intentionally <a href> (full page reload)
 * because the two consoles are separate SPA bundles served by
 * different artifacts. Trying to use wouter's <Link> here would
 * silently no-op — wouter would treat "/admin" as an in-app route
 * and either NotFound or push the URL without loading the other
 * bundle. The external-link icon visually signals the navigation
 * cost so operators aren't surprised by the brief reload.
 *
 * Active vs idle styling reuses the `.nav-item-active` /
 * `.nav-item-idle` utilities defined in index.css so the switcher
 * matches the main nav rail visually.
 */
export function ConsoleSwitcher() {
  return (
    <div
      className="border-b mb-3 pb-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="console-switcher"
    >
      <p
        className="text-[10px] uppercase tracking-[0.22em] font-semibold mb-2 px-2"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        Console
      </p>
      <div
        className="block px-4 py-2 text-sm rounded-md font-medium mb-1 nav-item-active"
        aria-current="page"
        data-testid="console-switcher-current"
      >
        Resupply CRM
      </div>
      <a
        href="/admin"
        className="flex items-center justify-between px-4 py-2 text-sm rounded-md font-medium nav-item-idle"
        data-testid="console-switcher-link-shop"
      >
        <span>Shop &amp; Fittings</span>
        <ExternalLink className="w-3.5 h-3.5 opacity-60" aria-hidden="true" />
      </a>
    </div>
  );
}
