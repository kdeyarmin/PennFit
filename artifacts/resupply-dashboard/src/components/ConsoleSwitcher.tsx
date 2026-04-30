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
 */
export function ConsoleSwitcher() {
  return (
    <div
      className="border-b mb-3 pb-3"
      style={{ borderColor: "#e5e7eb" }}
      data-testid="console-switcher"
    >
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-2 px-2"
        style={{ color: "#c9a24a" }}
      >
        Console
      </p>
      <div
        className="block px-4 py-2 text-sm rounded font-medium mb-1"
        style={{
          backgroundColor: "#0a1f44",
          color: "#ffffff",
          borderLeft: "3px solid #c9a24a",
        }}
        aria-current="page"
        data-testid="console-switcher-current"
      >
        Resupply CRM
      </div>
      <a
        href="/admin"
        className="flex items-center justify-between px-4 py-2 text-sm rounded font-medium transition-colors hover:bg-gray-100"
        style={{ color: "#0a1f44", borderLeft: "3px solid transparent" }}
        data-testid="console-switcher-link-shop"
      >
        <span>Shop &amp; Fittings</span>
        <ExternalLink className="w-3.5 h-3.5 opacity-60" aria-hidden="true" />
      </a>
    </div>
  );
}
