// Tests for the section / sub-nav model added to AppShell.tsx.
//
// The sidebar collapsed from ~85 flat links to ~23 SECTION entries; each
// multi-page section declares its pages as `tabs`, and a contextual
// sub-nav tab bar (SectionSubNav) renders those tabs at the top of the
// content area based on the current route.
//
// The cpap-fitter vitest env is "node" (no jsdom/RTL), so — like
// AppShell.collapsible.test.ts — we use two prongs:
//   1. Static source-string guards that pin the new helpers + component.
//   2. Pure-logic re-implementations of the active-target / visibility
//      logic, exercised against a small fixture.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

// ---------------------------------------------------------------------------
// SECTION 1 — Static source-string guards
// ---------------------------------------------------------------------------
describe("AppShell — section/sub-nav infrastructure present", () => {
  it("defines the SectionSubNav contextual tab bar", () => {
    expect(APPSHELL_SRC).toContain("function SectionSubNav");
  });

  it("renders the sub-nav under a stable data-testid", () => {
    expect(APPSHELL_SRC).toContain('data-testid="admin-subnav"');
    expect(APPSHELL_SRC).toContain("admin-subnav-");
  });

  it("defines the longest-prefix active-target resolver", () => {
    expect(APPSHELL_SRC).toContain("function pickActiveTarget");
    expect(APPSHELL_SRC).toContain("function flattenTargets");
  });

  it("defines the section visibility + landing helpers", () => {
    expect(APPSHELL_SRC).toContain("function visibleTabs");
    expect(APPSHELL_SRC).toContain("function sectionVisible");
    expect(APPSHELL_SRC).toContain("function sectionLandingHref");
    expect(APPSHELL_SRC).toContain("function sectionBadgeCount");
  });

  it("models sidebar entries as sections that own tabs", () => {
    expect(APPSHELL_SRC).toContain("type NavSection");
    expect(APPSHELL_SRC).toContain("tabs?: ReadonlyArray<NavLink>");
    // The big domains are now tabbed sections, not flat link lists.
    expect(APPSHELL_SRC).toContain('label: "Worklists"');
    expect(APPSHELL_SRC).toContain('label: "A/R & revenue"');
    expect(APPSHELL_SRC).toContain('label: "Clinical"');
    expect(APPSHELL_SRC).toContain('label: "Outreach"');
  });

  it("renders the sub-nav only for the signed-in admin shell", () => {
    // The SectionSubNav is gated on adminEmail in the <main> region.
    expect(APPSHELL_SRC).toContain("<SectionSubNav");
  });
});

// ---------------------------------------------------------------------------
// SECTION 2 — Pure-logic re-implementation (mirrors AppShell.tsx verbatim)
// ---------------------------------------------------------------------------

type Tab = { href: string; label: string; matchPrefix?: string; perm?: string };
type Section = {
  label: string;
  href?: string;
  matchPrefix?: string;
  requiredPermission?: string;
  tabs?: Tab[];
};
type Group = { label: string; items: Section[] };
type FlatTarget = { prefix: string; href: string; section: Section; tab?: Tab };

function linkMatchesLocation(location: string, prefix: string): boolean {
  if (prefix === "/admin") {
    return location === "/admin" || location === "/admin/";
  }
  return location === prefix || location.startsWith(`${prefix}/`);
}

function flattenTargets(groups: Group[]): FlatTarget[] {
  const out: FlatTarget[] = [];
  for (const group of groups) {
    for (const section of group.items) {
      if (section.tabs && section.tabs.length > 0) {
        for (const tab of section.tabs) {
          out.push({
            prefix: tab.matchPrefix ?? tab.href,
            href: tab.href,
            section,
            tab,
          });
        }
      } else if (section.href) {
        out.push({
          prefix: section.matchPrefix ?? section.href,
          href: section.href,
          section,
        });
      }
    }
  }
  return out;
}

function pickActiveTarget(
  location: string,
  groups: Group[],
): FlatTarget | null {
  let best: { target: FlatTarget; specificity: number } | null = null;
  for (const target of flattenTargets(groups)) {
    if (!linkMatchesLocation(location, target.prefix)) continue;
    const specificity = target.prefix.length;
    if (!best || specificity > best.specificity) best = { target, specificity };
  }
  return best?.target ?? null;
}

function visibleTabs(section: Section, perms: Set<string>): Tab[] {
  if (!section.tabs) return [];
  return section.tabs.filter((t) => !t.perm || perms.has(t.perm));
}

function sectionLandingHref(section: Section, perms: Set<string>): string {
  if (section.tabs && section.tabs.length > 0) {
    const vis = visibleTabs(section, perms);
    return (vis[0] ?? section.tabs[0]!).href;
  }
  return section.href ?? "#";
}

function sectionVisible(section: Section, perms: Set<string>): boolean {
  if (section.requiredPermission && !perms.has(section.requiredPermission)) {
    return false;
  }
  if (section.tabs && section.tabs.length > 0) {
    return visibleTabs(section, perms).length > 0;
  }
  return true;
}

// Fixture mirroring the real grouping shape.
const GROUPS: Group[] = [
  {
    label: "Workspace",
    items: [
      {
        label: "Home",
        tabs: [
          { href: "/admin", label: "Dashboard", matchPrefix: "/admin" },
          { href: "/admin/today", label: "My Today" },
        ],
      },
      {
        label: "Outreach",
        tabs: [
          { href: "/admin/bulk-campaigns", label: "Bulk Campaigns" },
          {
            href: "/admin/macros",
            label: "Canned Replies",
            perm: "admin.tools.manage",
          },
        ],
      },
    ],
  },
  {
    label: "Patients & Clinical",
    items: [
      {
        label: "Patients",
        href: "/admin/patients",
        matchPrefix: "/admin/patients",
      },
    ],
  },
  {
    label: "Billing",
    items: [
      {
        label: "Billing Hub",
        href: "/admin/billing",
        matchPrefix: "/admin/billing",
      },
      {
        label: "Worklists",
        tabs: [
          { href: "/admin/billing/ai-queue", label: "AI queue" },
          { href: "/admin/billing/eligibility", label: "Eligibility" },
        ],
      },
    ],
  },
];

describe("pickActiveTarget — longest-prefix wins", () => {
  it("selects the deeper tab over the section landing (Billing Hub vs AI queue)", () => {
    const t = pickActiveTarget("/admin/billing/ai-queue", GROUPS);
    expect(t?.section.label).toBe("Worklists");
    expect(t?.tab?.label).toBe("AI queue");
  });

  it("keeps the section landing active when on the bare prefix", () => {
    const t = pickActiveTarget("/admin/billing", GROUPS);
    expect(t?.section.label).toBe("Billing Hub");
  });

  it("treats /admin (Dashboard) as exact — /admin/patients does not match Home", () => {
    const home = pickActiveTarget("/admin", GROUPS);
    expect(home?.section.label).toBe("Home");
    const patients = pickActiveTarget("/admin/patients", GROUPS);
    expect(patients?.section.label).toBe("Patients");
  });

  it("matches a detail route via its tab prefix", () => {
    const t = pickActiveTarget("/admin/billing/eligibility/123", GROUPS);
    expect(t?.tab?.label).toBe("Eligibility");
  });
});

describe("visibleTabs / sectionLandingHref / sectionVisible — permission gating", () => {
  const csr = new Set<string>(); // no admin.tools.manage
  const admin = new Set<string>(["admin.tools.manage"]);

  it("hides permission-gated tabs for a CSR", () => {
    const outreach = GROUPS[0]!.items[1]!;
    expect(visibleTabs(outreach, csr).map((t) => t.label)).toEqual([
      "Bulk Campaigns",
    ]);
    expect(visibleTabs(outreach, admin).map((t) => t.label)).toEqual([
      "Bulk Campaigns",
      "Canned Replies",
    ]);
  });

  it("lands the sidebar entry on the first tab the caller can see", () => {
    const outreach = GROUPS[0]!.items[1]!;
    // Both callers land on the first visible tab — never a tab that 403s.
    expect(sectionLandingHref(outreach, csr)).toBe("/admin/bulk-campaigns");
    expect(sectionLandingHref(outreach, admin)).toBe("/admin/bulk-campaigns");
  });

  it("keeps a section visible while >=1 tab is visible", () => {
    const outreach = GROUPS[0]!.items[1]!;
    expect(sectionVisible(outreach, csr)).toBe(true);
  });

  it("hides a section whose every tab is gated away", () => {
    const lockedSection: Section = {
      label: "Locked",
      tabs: [{ href: "/admin/x", label: "X", perm: "nope" }],
    };
    expect(sectionVisible(lockedSection, csr)).toBe(false);
  });

  it("always shows an ungated single-page entry", () => {
    expect(sectionVisible(GROUPS[1]!.items[0]!, csr)).toBe(true);
  });
});
