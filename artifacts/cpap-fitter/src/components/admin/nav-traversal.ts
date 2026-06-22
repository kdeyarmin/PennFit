// Pure navigation model + traversal logic for the admin AppShell sidebar.
//
// Extracted from AppShell.tsx so the route-reachability rules — which tab
// is active for a location, which entries a permission set may see, where
// a sidebar entry lands — can be unit-tested directly instead of through
// a React render (the cpap-fitter vitest env is "node", no jsdom) or via
// verbatim re-implementations that drift from the real code.
//
// Everything here is pure: no React, no DOM, no localStorage. The sidebar
// *config* (NAV_GROUPS and friends) and the localStorage expand/collapse
// helpers stay in AppShell.tsx; this module only owns the types and the
// functions that walk a `ReadonlyArray<NavGroup>`.

import { type ComponentType, type SVGProps } from "react";

import { type AdminInboxCounts } from "@/lib/admin/inbox-counts-api";

// A single routable page. When it lives inside a section's `tabs`, it
// renders as a tab in the contextual sub-nav at the top of the content
// area (see SectionSubNav); when a section has no tabs the section IS the
// page and carries these fields directly.
export type NavLink = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  matchPrefix?: string;
  /** Optional one-line hint shown as a `title` for new reps. */
  hint?: string;
  /**
   * Phase 16 — actionable-work badge. When set, picks the count from
   * the inbox-counts query and shows it as a pill next to the label.
   * "0" suppresses rendering so we don't show empty badges everywhere.
   */
  badgeKey?:
    | "awaitingReplyConversations"
    | "pendingReturns"
    | "pendingReviews"
    | "overdueFollowups"
    | "newPatientDocuments"
    | "newInboundFaxes"
    | "pacwareReadyToSync";
  /**
   * Granular RBAC permission key required to USE the destination page
   * (e.g. `admin.tools.manage`). When set, the nav entry is hidden for
   * callers whose `/admin/me` permission set doesn't include it — so a
   * CSR never sees a link that would 403. Purely a UX guardrail; the
   * server-side `requirePermission(...)` is the real boundary.
   */
  requiredPermission?: string;
};

// One sidebar entry. Most entries are multi-page SECTIONS: the sidebar
// shows a single line, and clicking it opens the section's landing page
// with a horizontal tab bar (`tabs`) at the top of the content area so a
// rep can move between the pages that belong together WITHOUT hunting a
// long sidebar. A handful of entries are single pages — they omit `tabs`
// and carry `href` / `matchPrefix` / `badgeKey` directly.
export type NavSection = {
  /** Sidebar label. */
  label: string;
  /** Sidebar icon so reps scan visually rather than read every word. */
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Optional one-line hint shown as a `title` for new reps. */
  hint?: string;
  /** Sub-pages, rendered as the contextual sub-nav tab bar. */
  tabs?: ReadonlyArray<NavLink>;
  /** Single-page entry only: the route this links to (ignored with `tabs`). */
  href?: string;
  /** Single-page entry only: active-state prefix (defaults to `href`). */
  matchPrefix?: string;
  /** Single-page entry only: roll-up badge key. */
  badgeKey?: NavLink["badgeKey"];
  /** Permission gating the WHOLE entry (hidden if the caller lacks it). */
  requiredPermission?: string;
  /** Optional sidebar sub-cluster header within the group. */
  section?: string;
};

export type NavGroup = {
  label: string;
  items: ReadonlyArray<NavSection>;
};

export type FlatTarget = {
  prefix: string;
  href: string;
  group: NavGroup;
  section: NavSection;
  tab?: NavLink;
};

export function linkMatchesLocation(location: string, prefix: string): boolean {
  // The Dashboard ("/admin") target is exact-only — the bare /admin
  // route shouldn't claim every /admin/* subpath.
  if (prefix === "/admin") {
    return location === "/admin" || location === "/admin/";
  }
  return location === prefix || location.startsWith(`${prefix}/`);
}

/**
 * Every routable target (each tab, plus single-page entries) flattened
 * with a back-reference to its owning section + group, so active-route
 * detection is a single longest-prefix pass.
 */
export function flattenTargets(groups: ReadonlyArray<NavGroup>): FlatTarget[] {
  const out: FlatTarget[] = [];
  for (const group of groups) {
    for (const section of group.items) {
      if (section.tabs && section.tabs.length > 0) {
        for (const tab of section.tabs) {
          out.push({
            prefix: tab.matchPrefix ?? tab.href,
            href: tab.href,
            group,
            section,
            tab,
          });
        }
      } else if (section.href) {
        out.push({
          prefix: section.matchPrefix ?? section.href,
          href: section.href,
          group,
          section,
        });
      }
    }
  }
  return out;
}

/**
 * Longest-prefix-wins active selection. When a section landing
 * ("Billing Hub" @ /admin/billing) and a deeper tab ("AI queue" @
 * /admin/billing/ai-queue) both match the current location, only the
 * more specific one wins. Ties go to the first seen (NAV_GROUPS order).
 */
export function pickActiveTarget(
  location: string,
  groups: ReadonlyArray<NavGroup>,
): FlatTarget | null {
  let best: { target: FlatTarget; specificity: number } | null = null;
  for (const target of flattenTargets(groups)) {
    if (!linkMatchesLocation(location, target.prefix)) continue;
    const specificity = target.prefix.length;
    if (!best || specificity > best.specificity) {
      best = { target, specificity };
    }
  }
  return best?.target ?? null;
}

/**
 * The active tab/section href. Kept as a named helper the AppShell and
 * the nav tests reference.
 */
export function pickActiveHref(
  location: string,
  groups: ReadonlyArray<NavGroup>,
): string | null {
  const target = pickActiveTarget(location, groups);
  if (!target) return null;
  return target.tab?.href ?? target.href;
}

/**
 * Find which NAV_GROUPS group owns the currently-active route, so that
 * group can be auto-expanded for a rep who deep-links into a collapsed
 * section.
 */
export function findGroupForActiveHref(
  groups: ReadonlyArray<NavGroup>,
  activeHref: string | null,
): string | null {
  if (!activeHref) return null;
  for (const group of groups) {
    for (const section of group.items) {
      if (section.href === activeHref) return group.label;
      if (section.tabs?.some((tab) => tab.href === activeHref)) {
        return group.label;
      }
    }
  }
  return null;
}

/** Tabs of a section the caller is allowed to open. */
export function visibleTabs(
  section: NavSection,
  permissions: ReadonlySet<string>,
): ReadonlyArray<NavLink> {
  if (!section.tabs) return [];
  return section.tabs.filter(
    (tab) => !tab.requiredPermission || permissions.has(tab.requiredPermission),
  );
}

/**
 * Where the sidebar entry links: the first tab the caller can actually
 * see (so a CSR never lands on a tab that 403s), or the single-page href.
 */
export function sectionLandingHref(
  section: NavSection,
  permissions: ReadonlySet<string>,
): string {
  if (section.tabs && section.tabs.length > 0) {
    const visible = visibleTabs(section, permissions);
    return (visible[0] ?? section.tabs[0]!).href;
  }
  return section.href ?? "#";
}

/** Whether the caller may see this sidebar entry at all. */
export function sectionVisible(
  section: NavSection,
  permissions: ReadonlySet<string>,
): boolean {
  if (
    section.requiredPermission &&
    !permissions.has(section.requiredPermission)
  ) {
    return false;
  }
  if (section.tabs && section.tabs.length > 0) {
    return visibleTabs(section, permissions).length > 0;
  }
  return true;
}

/**
 * Total actionable-work badge for a sidebar entry: its own badge plus the
 * rolled-up badges of every tab the caller can see.
 */
export function sectionBadgeCount(
  section: NavSection,
  counts: AdminInboxCounts | undefined,
  permissions: ReadonlySet<string>,
): number {
  let total = section.badgeKey ? (counts?.[section.badgeKey] ?? 0) : 0;
  for (const tab of visibleTabs(section, permissions)) {
    if (tab.badgeKey) total += counts?.[tab.badgeKey] ?? 0;
  }
  return total;
}
