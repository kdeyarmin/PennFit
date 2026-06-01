// Static guards for AppShell.tsx nav items.
//
// NAV_GROUPS is not exported from AppShell.tsx, so we read the source file
// directly and assert the expected route hrefs, labels, and hints are
// present — and that retired items stay removed.  This mirrors the approach
// used in admin.scope.test.ts and gives a quick, zero-rendering guard that
// nav changes don't silently regress.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

// ---------------------------------------------------------------------------
// New nav item: Appointment requests (Inbox group)
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — appointment-requests entry (Inbox group)", () => {
  it("registers the /admin/appointment-requests href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/appointment-requests"');
  });

  it("uses 'Appointment requests' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Appointment requests"');
  });

  it("uses /admin/appointment-requests as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain(
      'matchPrefix: "/admin/appointment-requests"',
    );
  });

  it("includes a descriptive hint for the CSR appointment-requests queue", () => {
    expect(APPSHELL_SRC).toContain(
      "CSR queue for patient-initiated appointment requests",
    );
  });

  it("imports CalendarPlus from lucide-react (icon used by the new item)", () => {
    expect(APPSHELL_SRC).toContain("CalendarPlus");
  });
});

// ---------------------------------------------------------------------------
// New nav item: Integrations (Insights group)
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — integrations entry (Insights group)", () => {
  it("registers the /admin/integrations href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/integrations"');
  });

  it("uses 'Integrations' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Integrations"');
  });

  it("uses /admin/integrations as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain('matchPrefix: "/admin/integrations"');
  });

  it("includes a descriptive hint about therapy-cloud vendor connections", () => {
    expect(APPSHELL_SRC).toContain(
      "Therapy-cloud vendor connections and nightly sync status",
    );
  });

  it("imports Plug from lucide-react (icon used by the new item)", () => {
    expect(APPSHELL_SRC).toContain("Plug");
  });
});

// ---------------------------------------------------------------------------
// Retired: Audit Log, Compliance binder, and Accreditation binder.
//
// These three System-group items pointed at routes that were never mounted
// (they 404'd to NotFound) and surfaced the in-app compliance machinery that
// migration 0156 retired. They were removed from AppShell; these guards keep
// them from being re-added (the re-add churn this file's history documents).
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — retired compliance/audit nav items absent", () => {
  it("does not register the /admin/audit (Audit Log) nav item", () => {
    expect(APPSHELL_SRC).not.toContain('href: "/admin/audit"');
    expect(APPSHELL_SRC).not.toContain('label: "Audit Log"');
  });

  it("does not register the /admin/compliance (Compliance binder) nav item", () => {
    expect(APPSHELL_SRC).not.toContain('href: "/admin/compliance"');
    expect(APPSHELL_SRC).not.toContain('label: "Compliance binder"');
  });

  it("does not register the /admin/accreditation-binder nav item", () => {
    expect(APPSHELL_SRC).not.toContain('href: "/admin/accreditation-binder"');
    expect(APPSHELL_SRC).not.toContain('label: "Accreditation binder"');
  });

  it("does not register the /admin/pennpaps/audit (Storefront Audit) nav item", () => {
    // The storefront audit-trail page was retired with the rest of the
    // audit machinery (0156), but its nav entry lingered and routed to a
    // 404 because no matching Route exists in console.tsx. Pin its absence.
    expect(APPSHELL_SRC).not.toContain('href: "/admin/pennpaps/audit"');
    expect(APPSHELL_SRC).not.toContain('label: "Storefront Audit"');
  });

  it("no longer imports the ClipboardList icon (only the removed binder used it)", () => {
    expect(APPSHELL_SRC).not.toContain("ClipboardList");
  });

  it("no longer imports the FileSearch icon (only the removed audit item used it)", () => {
    expect(APPSHELL_SRC).not.toContain("FileSearch");
  });
});

// ---------------------------------------------------------------------------
// New nav group: Billing — five entries mounted alongside Orders & Shop.
//   Headline page: /admin/billing  (Billing Hub)
//   Sub-pages:     /admin/billing/{ai-queue,aging,denials,era}
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — billing group", () => {
  it("registers a 'Billing' nav group label", () => {
    expect(APPSHELL_SRC).toContain('label: "Billing"');
  });

  const billingRoutes: ReadonlyArray<[string, string]> = [
    ["/admin/billing", "Billing Hub"],
    ["/admin/billing/ai-queue", "AI queue"],
    ["/admin/billing/eligibility", "Eligibility"],
    ["/admin/billing/prior-auths", "Prior auths"],
    ["/admin/billing/aging", "A/R aging"],
    ["/admin/billing/denials", "Denials & DSO"],
    ["/admin/billing/era", "ERA files"],
    ["/admin/billing/capped-rentals", "Capped rentals"],
    ["/admin/billing/config", "Config"],
  ];

  for (const [href, label] of billingRoutes) {
    it(`mounts ${label} at ${href}`, () => {
      expect(APPSHELL_SRC).toContain(`href: "${href}"`);
      expect(APPSHELL_SRC).toContain(`label: "${label}"`);
      expect(APPSHELL_SRC).toContain(`matchPrefix: "${href}"`);
    });
  }

  it("imports the lucide icons used by the billing group", () => {
    expect(APPSHELL_SRC).toContain("CircleDollarSign");
    expect(APPSHELL_SRC).toContain("Wallet");
    expect(APPSHELL_SRC).toContain("Bot");
    expect(APPSHELL_SRC).toContain("ListFilter");
    expect(APPSHELL_SRC).toContain("TrendingDown");
    expect(APPSHELL_SRC).toContain("ClipboardCheck");
    expect(APPSHELL_SRC).toContain("ShieldAlert");
    expect(APPSHELL_SRC).toContain("SlidersHorizontal");
    expect(APPSHELL_SRC).toContain("CalendarRange");
  });
});

// ---------------------------------------------------------------------------
// Regression: pre-existing routes are undisturbed
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — pre-existing routes not removed by this PR", () => {
  const expectedRoutes = [
    "/admin/followups",
    "/admin/macros",
    "/admin/patients",
    "/admin/delivery-failures",
    "/admin/operations",
  ];

  for (const route of expectedRoutes) {
    it(`retains ${route}`, () => {
      expect(APPSHELL_SRC).toContain(`href: "${route}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// Collapsible nav machinery — structural regression guards
//
// A feature branch once tried to strip the collapsible-sidebar machinery
// in favour of static always-open groups; that change was reverted on
// main. These guards pin the collapsible implementation that ships: the
// per-group expand/collapse state, its localStorage persistence, and the
// deep-link auto-expand.
// ---------------------------------------------------------------------------
describe("AppShell — collapsible nav machinery present", () => {
  it("imports ChevronRight from lucide-react (group toggle chevron)", () => {
    expect(APPSHELL_SRC).toContain("ChevronRight");
  });

  it("imports useRef from react", () => {
    expect(APPSHELL_SRC).toContain("useRef");
  });

  it("defines findGroupForActiveHref helper", () => {
    expect(APPSHELL_SRC).toContain("function findGroupForActiveHref");
  });

  it("defines loadInitialExpandedGroups helper", () => {
    expect(APPSHELL_SRC).toContain("function loadInitialExpandedGroups");
  });

  it("defines persistExpandedGroups helper", () => {
    expect(APPSHELL_SRC).toContain("function persistExpandedGroups");
  });

  it("defines loadExplicitCollapsedGroups helper", () => {
    expect(APPSHELL_SRC).toContain("function loadExplicitCollapsedGroups");
  });

  it("defines persistExplicitCollapsedGroups helper", () => {
    expect(APPSHELL_SRC).toContain("function persistExplicitCollapsedGroups");
  });

  it("defines groupDomId for aria-controls IDs", () => {
    expect(APPSHELL_SRC).toContain("function groupDomId");
  });

  it("defines toggleNavGroup inside AppShell", () => {
    expect(APPSHELL_SRC).toContain("function toggleNavGroup(label: string)");
  });

  it("uses NAV_EXPANDED_STORAGE_KEY for persisted expansion state", () => {
    expect(APPSHELL_SRC).toContain("NAV_EXPANDED_STORAGE_KEY");
  });

  it("migrates legacy expanded-group labels on load", () => {
    expect(APPSHELL_SRC).toContain("NAV_GROUP_LABEL_MIGRATION");
    expect(APPSHELL_SRC).toContain('Inbox: "Workspace"');
    expect(APPSHELL_SRC).toContain('Customers: "Patients & Clinical"');
    expect(APPSHELL_SRC).toContain('Insights: "Analytics & Reports"');
  });

  it("uses NAV_EXPLICIT_COLLAPSED_STORAGE_KEY for explicit collapses", () => {
    expect(APPSHELL_SRC).toContain("NAV_EXPLICIT_COLLAPSED_STORAGE_KEY");
  });

  it("tracks navExpanded state", () => {
    expect(APPSHELL_SRC).toContain("navExpanded");
  });

  it("tracks navExplicitCollapsed state", () => {
    expect(APPSHELL_SRC).toContain("navExplicitCollapsed");
  });

  it("uses hidden={!isOpen} to toggle group visibility", () => {
    expect(APPSHELL_SRC).toContain("hidden={!isOpen}");
  });

  it("passes the expanded prop to SidebarNavBody", () => {
    expect(APPSHELL_SRC).toContain("expanded: Set<string>");
  });

  it("passes the onToggleGroup prop to SidebarNavBody", () => {
    expect(APPSHELL_SRC).toContain("onToggleGroup: (label: string) => void");
  });
});

// ---------------------------------------------------------------------------
// SidebarNavBody renders collapsible group toggles
// ---------------------------------------------------------------------------
describe("AppShell — SidebarNavBody renders collapsible group toggles", () => {
  it("renders each group label inside a toggle button styled with tracking-[0.22em]", () => {
    expect(APPSHELL_SRC).toContain("uppercase tracking-[0.22em] font-semibold");
  });

  it("still iterates over NAV_GROUPS to render sections", () => {
    expect(APPSHELL_SRC).toContain("NAV_GROUPS.map((group) =>");
  });

  it("still renders NavItem for each link within a group", () => {
    expect(APPSHELL_SRC).toContain("NavItem");
    // The item map now takes an index so it can detect when an item
    // starts a new sub-section and emit a sub-header above it.
    expect(APPSHELL_SRC).toContain("group.items.map((link, idx) =>");
  });

  it("renders a sub-section sub-header when an item starts a new section", () => {
    // Large groups are broken into labelled clusters via the optional
    // `section` tag on each NavLink; the body emits a muted sub-header
    // whenever an item's section differs from the previous item's.
    expect(APPSHELL_SRC).toContain("showSectionHeader");
    expect(APPSHELL_SRC).toContain("admin-nav-subsection-");
  });
});

// ---------------------------------------------------------------------------
// Permission-gated nav entries.
//
// Alert Library, Canned Replies, and Message Templates are all gated on
// the backend `admin.tools.manage` permission. The sidebar must hide
// them for callers who lack it (a CSR), so they don't see a link that
// would 403. These guard the requiredPermission tagging + the filter.
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — admin.tools.manage gated entries", () => {
  const gatedHrefs = ["/admin/macros", "/admin/templates", "/admin/alerts"];

  for (const href of gatedHrefs) {
    it(`tags ${href} with requiredPermission admin.tools.manage`, () => {
      // The href and the permission tag must both appear; we assert the
      // permission string is present at least once per gated entry by
      // checking the block around the href contains it.
      const idx = APPSHELL_SRC.indexOf(`href: "${href}"`);
      expect(idx).toBeGreaterThan(-1);
      const block = APPSHELL_SRC.slice(idx, idx + 260);
      expect(block).toContain('requiredPermission: "admin.tools.manage"');
    });
  }

  it("filters nav items by the caller's permission set", () => {
    // Sidebar entries are filtered through sectionVisible(...), which hides
    // an entry the caller lacks permission for and — for multi-page sections
    // — keeps it only while at least one tab the caller can see remains.
    expect(APPSHELL_SRC).toContain("sectionVisible(link, permissions)");
    expect(APPSHELL_SRC).toContain(
      "permissions.has(section.requiredPermission)",
    );
    expect(APPSHELL_SRC).toContain("permissions.has(tab.requiredPermission)");
  });

  it("drops groups left with no visible items after filtering", () => {
    expect(APPSHELL_SRC).toContain("group.items.length > 0");
  });
});
