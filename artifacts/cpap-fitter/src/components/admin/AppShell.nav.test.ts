// Static guard for the three nav items added to AppShell.tsx in this PR:
//   - /admin/appointment-requests  (Inbox group)
//   - /admin/integrations          (Insights group)
//   - /admin/accreditation-binder  (System group)
//
// NAV_GROUPS is not exported from AppShell.tsx, so we read the source file
// directly and assert the expected route hrefs, labels, and hints are
// present.  This mirrors the approach used in admin.scope.test.ts and gives
// a quick, zero-rendering guard that route additions don't silently regress.

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
// New nav item: Accreditation binder (System group)
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — accreditation-binder entry (System group)", () => {
  it("registers the /admin/accreditation-binder href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/accreditation-binder"');
  });

  it("uses 'Accreditation binder' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Accreditation binder"');
  });

  it("uses /admin/accreditation-binder as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain(
      'matchPrefix: "/admin/accreditation-binder"',
    );
  });

  it("includes a descriptive hint mentioning DMEPOS evidence rollup", () => {
    expect(APPSHELL_SRC).toContain("Surveyor-facing DMEPOS evidence rollup");
  });

  it("imports ClipboardList from lucide-react (icon used by the new item)", () => {
    expect(APPSHELL_SRC).toContain("ClipboardList");
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
    "/admin/compliance",
  ];

  for (const route of expectedRoutes) {
    it(`retains ${route}`, () => {
      expect(APPSHELL_SRC).toContain(`href: "${route}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// This PR: Audit Log nav item re-added to System group
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — audit-log entry (System group)", () => {
  it("registers the /admin/audit href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/audit"');
  });

  it("uses 'Audit Log' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Audit Log"');
  });

  it("uses /admin/audit as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain('matchPrefix: "/admin/audit"');
  });

  it("includes a descriptive hint for the audit trail", () => {
    expect(APPSHELL_SRC).toContain("Resupply admin activity trail");
  });
});

// ---------------------------------------------------------------------------
// This PR: Compliance binder nav item re-added to System group
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — compliance-binder entry (System group)", () => {
  it("registers the /admin/compliance href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/compliance"');
  });

  it("uses 'Compliance binder' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Compliance binder"');
  });

  it("uses /admin/compliance as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain('matchPrefix: "/admin/compliance"');
  });

  it("includes a hint mentioning DMEPOS surveyors", () => {
    expect(APPSHELL_SRC).toContain(
      "Staff training records + patient grievances for DMEPOS surveyors",
    );
  });
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
    expect(APPSHELL_SRC).toContain("group.items.map((link) =>");
  });
});

// ---------------------------------------------------------------------------
// This PR: imports ClipboardList (for accreditation-binder icon)
// ---------------------------------------------------------------------------
describe("AppShell — ClipboardList icon imported for accreditation-binder", () => {
  it("imports ClipboardList from lucide-react", () => {
    expect(APPSHELL_SRC).toContain("ClipboardList");
  });
});
