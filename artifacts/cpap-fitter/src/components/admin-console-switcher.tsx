import { ExternalLink } from "lucide-react";

/**
 * AdminConsoleSwitcher — top-of-sidebar block that lets operators jump
 * between the two admin surfaces:
 *
 *   - Shop & Fittings (this app, mounted at /admin): new-order intake
 *     from the virtual mask fitter, reminders, audit log.
 *   - Resupply CRM (the resupply-dashboard, mounted at /resupply):
 *     patient roster, unified inbox, rules engine, shop inventory.
 *
 * Cross-console links use <a href> (full page reload) because the
 * two consoles are separate SPA bundles served by different
 * artifacts. Wouter's <Link> would either NotFound or update the URL
 * without loading the other bundle. The external-link icon makes
 * the navigation cost visible.
 */
export function AdminConsoleSwitcher() {
  return (
    <div
      className="mb-3 pb-3 border-b border-border/50"
      data-testid="admin-console-switcher"
    >
      <p className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-2 px-3 text-muted-foreground">
        Console
      </p>
      <div
        className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium mb-1"
        aria-current="page"
        data-testid="admin-console-switcher-current"
      >
        Shop &amp; Fittings
      </div>
      <a
        href="/resupply/"
        className="flex items-center justify-between px-3 py-2 rounded-lg text-sm hover:bg-muted text-foreground transition-colors"
        data-testid="admin-console-switcher-link-resupply"
      >
        <span>Resupply CRM</span>
        <ExternalLink className="w-3.5 h-3.5 opacity-60" aria-hidden="true" />
      </a>
    </div>
  );
}
