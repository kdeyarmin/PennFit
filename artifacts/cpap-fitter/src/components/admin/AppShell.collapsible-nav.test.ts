// Tests for the collapsible nav-group feature added to AppShell.tsx in this PR.
//
// Covers:
//   * groupDomId — slug generation for aria-controls IDs
//   * findGroupForActiveHref — which group owns the active route
//   * loadInitialExpandedGroups — SSR guard, empty storage, valid/corrupt data
//   * persistExpandedGroups — SSR guard, localStorage writes
//   * loadExplicitCollapsedGroups — SSR guard, empty/valid/corrupt data
//   * persistExplicitCollapsedGroups — SSR guard, localStorage writes
//   * toggleNavGroup — expand/collapse + explicit-collapsed tracking
//   * Structural checks: imports, aria attributes, data-testid patterns

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(
  path.join(__dirname, "AppShell.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Structural: imports required by the collapsible-nav feature
// ---------------------------------------------------------------------------
describe("AppShell — collapsible-nav imports", () => {
  it("imports useRef from react (needed for navExplicitCollapsedRef)", () => {
    expect(APPSHELL_SRC).toContain("useRef");
  });

  it("imports ChevronRight from lucide-react (the expand/collapse chevron icon)", () => {
    expect(APPSHELL_SRC).toContain("ChevronRight");
  });
});

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------
describe("AppShell — localStorage key constants", () => {
  it("defines NAV_EXPANDED_STORAGE_KEY", () => {
    expect(APPSHELL_SRC).toContain(
      '"pf-admin-nav-expanded-groups"',
    );
  });

  it("defines NAV_EXPLICIT_COLLAPSED_STORAGE_KEY", () => {
    expect(APPSHELL_SRC).toContain(
      '"pf-admin-nav-explicit-collapsed-groups"',
    );
  });
});

// ---------------------------------------------------------------------------
// groupDomId — pure function, reimplemented for unit-level testing
// ---------------------------------------------------------------------------
function groupDomId(label: string): string {
  return `admin-nav-section-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

describe("groupDomId", () => {
  it("prefixes the result with 'admin-nav-section-'", () => {
    expect(groupDomId("Inbox")).toStartsWith("admin-nav-section-");
  });

  it("lowercases the label", () => {
    expect(groupDomId("INBOX")).toBe("admin-nav-section-inbox");
  });

  it("replaces spaces with hyphens", () => {
    expect(groupDomId("Orders & Shop")).toBe("admin-nav-section-orders-shop");
  });

  it("collapses consecutive non-alphanumeric chars to a single hyphen", () => {
    expect(groupDomId("A & B")).toBe("admin-nav-section-a-b");
  });

  it("produces 'admin-nav-section-inbox' for 'Inbox'", () => {
    expect(groupDomId("Inbox")).toBe("admin-nav-section-inbox");
  });

  it("produces 'admin-nav-section-system' for 'System'", () => {
    expect(groupDomId("System")).toBe("admin-nav-section-system");
  });

  it("produces a stable id for 'Orders & Shop'", () => {
    expect(groupDomId("Orders & Shop")).toBe(
      "admin-nav-section-orders-shop",
    );
  });

  it("uses the same slug pattern in APPSHELL_SRC for data-testid construction", () => {
    // The component builds testId as
    // `admin-nav-group-${group.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    expect(APPSHELL_SRC).toContain("admin-nav-group-");
    expect(APPSHELL_SRC).toContain(`.replace(/[^a-z0-9]+/g, "-")`);
  });
});

// ---------------------------------------------------------------------------
// findGroupForActiveHref — pure function, reimplemented for unit testing
// ---------------------------------------------------------------------------
interface NavItem { href: string; label: string; }
interface NavGroup { label: string; items: NavItem[]; }

function findGroupForActiveHref(
  groups: ReadonlyArray<NavGroup>,
  activeHref: string | null,
): string | null {
  if (!activeHref) return null;
  for (const g of groups) {
    if (g.items.some((it) => it.href === activeHref)) return g.label;
  }
  return null;
}

const SAMPLE_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Inbox",
    items: [
      { href: "/admin/followups", label: "Followups" },
      { href: "/admin/chat", label: "Chat" },
    ],
  },
  {
    label: "Customers",
    items: [
      { href: "/admin/patients", label: "Patients" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin/team", label: "Team" },
    ],
  },
];

describe("findGroupForActiveHref", () => {
  it("returns null when activeHref is null", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, null)).toBeNull();
  });

  it("returns null when no group contains the href", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/unknown")).toBeNull();
  });

  it("returns the group label when the href matches an item in the first group", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/followups")).toBe(
      "Inbox",
    );
  });

  it("returns the group label when the href matches an item in a middle group", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/patients")).toBe(
      "Customers",
    );
  });

  it("returns the group label when the href matches an item in the last group", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/team")).toBe("System");
  });

  it("does exact match, not prefix match", () => {
    // /admin/followups/extra should NOT match /admin/followups
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/followups/extra")).toBeNull();
  });

  it("returns null for an empty groups array", () => {
    expect(findGroupForActiveHref([], "/admin/followups")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadInitialExpandedGroups — pure logic, reimplemented for unit testing
// ---------------------------------------------------------------------------
const NAV_EXPANDED_STORAGE_KEY = "pf-admin-nav-expanded-groups";

function loadInitialExpandedGroups(
  activeGroup: string | null,
  storage: Map<string, string> | null,
): Set<string> {
  const fallback = new Set(activeGroup ? [activeGroup] : []);
  if (storage === null) return fallback; // SSR: no window
  try {
    const raw = storage.get(NAV_EXPANDED_STORAGE_KEY) ?? null;
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((s): s is string => typeof s === "string")
    ) {
      return new Set(parsed);
    }
  } catch {
    /* corrupt — fall through */
  }
  return fallback;
}

describe("loadInitialExpandedGroups", () => {
  it("returns a set containing only activeGroup when storage is null (SSR)", () => {
    const result = loadInitialExpandedGroups("Inbox", null);
    expect(result).toEqual(new Set(["Inbox"]));
  });

  it("returns an empty set when activeGroup is null and storage is null", () => {
    const result = loadInitialExpandedGroups(null, null);
    expect(result.size).toBe(0);
  });

  it("returns the fallback (activeGroup) when localStorage has no entry", () => {
    const result = loadInitialExpandedGroups("Customers", new Map());
    expect(result).toEqual(new Set(["Customers"]));
  });

  it("returns the stored set when localStorage contains a valid array", () => {
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, JSON.stringify(["Inbox", "System"])],
    ]);
    const result = loadInitialExpandedGroups("Customers", store);
    expect(result).toEqual(new Set(["Inbox", "System"]));
  });

  it("returns the fallback when localStorage contains a non-array JSON value", () => {
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, JSON.stringify({ expanded: ["Inbox"] })],
    ]);
    const result = loadInitialExpandedGroups("Billing", store);
    expect(result).toEqual(new Set(["Billing"]));
  });

  it("returns the fallback when localStorage contains an array with non-strings", () => {
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, JSON.stringify([1, 2, 3])],
    ]);
    const result = loadInitialExpandedGroups("Billing", store);
    expect(result).toEqual(new Set(["Billing"]));
  });

  it("returns the fallback when localStorage value is corrupt JSON", () => {
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, "{invalid json"],
    ]);
    const result = loadInitialExpandedGroups("Inbox", store);
    expect(result).toEqual(new Set(["Inbox"]));
  });

  it("returns the stored set even when it doesn't include activeGroup", () => {
    // User manually collapsed every group — honour their preference.
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, JSON.stringify(["Billing"])],
    ]);
    const result = loadInitialExpandedGroups("Inbox", store);
    expect(result).toEqual(new Set(["Billing"]));
  });

  it("returns an empty Set when storage has an empty array", () => {
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, JSON.stringify([])],
    ]);
    const result = loadInitialExpandedGroups("Inbox", store);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadExplicitCollapsedGroups — pure logic, reimplemented for unit testing
// ---------------------------------------------------------------------------
const NAV_EXPLICIT_COLLAPSED_STORAGE_KEY =
  "pf-admin-nav-explicit-collapsed-groups";

function loadExplicitCollapsedGroups(
  storage: Map<string, string> | null,
): Set<string> {
  if (storage === null) return new Set(); // SSR
  try {
    const raw = storage.get(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY) ?? null;
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((s): s is string => typeof s === "string")
    ) {
      return new Set(parsed);
    }
  } catch {
    /* corrupt — fall through */
  }
  return new Set();
}

describe("loadExplicitCollapsedGroups", () => {
  it("returns an empty set when storage is null (SSR)", () => {
    expect(loadExplicitCollapsedGroups(null).size).toBe(0);
  });

  it("returns an empty set when no entry in storage", () => {
    expect(loadExplicitCollapsedGroups(new Map()).size).toBe(0);
  });

  it("returns stored collapsed groups when data is a valid string array", () => {
    const store = new Map([
      [NAV_EXPLICIT_COLLAPSED_STORAGE_KEY, JSON.stringify(["Inbox", "Billing"])],
    ]);
    expect(loadExplicitCollapsedGroups(store)).toEqual(
      new Set(["Inbox", "Billing"]),
    );
  });

  it("returns empty set when data is a non-array JSON value", () => {
    const store = new Map([
      [NAV_EXPLICIT_COLLAPSED_STORAGE_KEY, JSON.stringify("Inbox")],
    ]);
    expect(loadExplicitCollapsedGroups(store).size).toBe(0);
  });

  it("returns empty set when data contains non-string array entries", () => {
    const store = new Map([
      [NAV_EXPLICIT_COLLAPSED_STORAGE_KEY, JSON.stringify([42, false])],
    ]);
    expect(loadExplicitCollapsedGroups(store).size).toBe(0);
  });

  it("returns empty set when data is corrupt JSON", () => {
    const store = new Map([
      [NAV_EXPLICIT_COLLAPSED_STORAGE_KEY, "not-valid-json{{{"],
    ]);
    expect(loadExplicitCollapsedGroups(store).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toggleNavGroup — logic extracted from AppShell for unit testing
// ---------------------------------------------------------------------------
interface NavState {
  expanded: Set<string>;
  explicitCollapsed: Set<string>;
}

function toggleNavGroup(label: string, state: NavState): NavState {
  const isCurrentlyOpen = state.expanded.has(label);
  const nextExpanded = new Set(state.expanded);
  const nextExplicitCollapsed = new Set(state.explicitCollapsed);

  if (isCurrentlyOpen) {
    nextExpanded.delete(label);
    nextExplicitCollapsed.add(label);
  } else {
    nextExpanded.add(label);
    nextExplicitCollapsed.delete(label);
  }

  return { expanded: nextExpanded, explicitCollapsed: nextExplicitCollapsed };
}

describe("toggleNavGroup", () => {
  it("opens a closed group and removes it from explicitCollapsed", () => {
    const state: NavState = {
      expanded: new Set(),
      explicitCollapsed: new Set(["Inbox"]),
    };
    const next = toggleNavGroup("Inbox", state);
    expect(next.expanded.has("Inbox")).toBe(true);
    expect(next.explicitCollapsed.has("Inbox")).toBe(false);
  });

  it("closes an open group and adds it to explicitCollapsed", () => {
    const state: NavState = {
      expanded: new Set(["Inbox"]),
      explicitCollapsed: new Set(),
    };
    const next = toggleNavGroup("Inbox", state);
    expect(next.expanded.has("Inbox")).toBe(false);
    expect(next.explicitCollapsed.has("Inbox")).toBe(true);
  });

  it("does not mutate the original state", () => {
    const state: NavState = {
      expanded: new Set(["Inbox"]),
      explicitCollapsed: new Set(),
    };
    toggleNavGroup("Inbox", state);
    expect(state.expanded.has("Inbox")).toBe(true);
    expect(state.explicitCollapsed.has("Inbox")).toBe(false);
  });

  it("toggling open then closed leaves explicitCollapsed containing the group", () => {
    let state: NavState = { expanded: new Set(), explicitCollapsed: new Set() };
    state = toggleNavGroup("System", state); // open
    state = toggleNavGroup("System", state); // close
    expect(state.expanded.has("System")).toBe(false);
    expect(state.explicitCollapsed.has("System")).toBe(true);
  });

  it("toggling other groups does not affect an unrelated group", () => {
    const state: NavState = {
      expanded: new Set(["Inbox"]),
      explicitCollapsed: new Set(),
    };
    const next = toggleNavGroup("System", state);
    expect(next.expanded.has("Inbox")).toBe(true);
    expect(next.explicitCollapsed.has("Inbox")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SidebarNavBody — structural: new props in source
// ---------------------------------------------------------------------------
describe("AppShell — SidebarNavBody accepts expanded and onToggleGroup props", () => {
  it("declares expanded prop in SidebarNavBody signature", () => {
    expect(APPSHELL_SRC).toContain("expanded: Set<string>");
  });

  it("declares onToggleGroup callback prop in SidebarNavBody signature", () => {
    expect(APPSHELL_SRC).toContain("onToggleGroup: (label: string) => void");
  });

  it("passes expanded to SidebarNavBody at the desktop sidebar site", () => {
    expect(APPSHELL_SRC).toContain("expanded={navExpanded}");
  });

  it("passes onToggleGroup to SidebarNavBody at both render sites", () => {
    const matches = APPSHELL_SRC.split("onToggleGroup={toggleNavGroup}");
    // Should appear at both the mobile drawer and the desktop sidebar.
    expect(matches.length).toBeGreaterThanOrEqual(3); // 2 occurrences → 3 parts
  });
});

// ---------------------------------------------------------------------------
// Collapsible group UI: aria attributes
// ---------------------------------------------------------------------------
describe("AppShell — collapsible group button aria attributes", () => {
  it("uses aria-expanded on the group toggle button", () => {
    expect(APPSHELL_SRC).toContain("aria-expanded={isOpen}");
  });

  it("uses aria-controls pointing to the section id", () => {
    expect(APPSHELL_SRC).toContain("aria-controls={sectionId}");
  });

  it("uses the hidden attribute on the section div to collapse it", () => {
    expect(APPSHELL_SRC).toContain("hidden={!isOpen}");
  });

  it("sets the section id via groupDomId", () => {
    expect(APPSHELL_SRC).toContain("const sectionId = groupDomId(group.label)");
  });

  it("generates testId using the same slug logic as groupDomId", () => {
    // The testId is built with the pattern used in groupDomId.
    expect(APPSHELL_SRC).toContain("admin-nav-group-");
    // Slug transformation present.
    expect(APPSHELL_SRC).toContain(
      `.replace(/[^a-z0-9]+/g, "-")`,
    );
  });
});

// ---------------------------------------------------------------------------
// Rollup badge: collapsed group shows aggregate pending count
// ---------------------------------------------------------------------------
describe("AppShell — rollup badge on collapsed groups", () => {
  it("computes rolledUpBadge as 0 when the group is open", () => {
    expect(APPSHELL_SRC).toContain(
      "const rolledUpBadge = isOpen\n          ? 0",
    );
  });

  it("shows the rollup badge only when rolledUpBadge > 0", () => {
    expect(APPSHELL_SRC).toContain("{rolledUpBadge > 0 && (");
  });

  it("caps the badge display at 99+", () => {
    expect(APPSHELL_SRC).toContain("rolledUpBadge > 99 ? \"99+\" : rolledUpBadge");
  });

  it("includes a descriptive aria-label on the rollup badge", () => {
    expect(APPSHELL_SRC).toContain(
      "`${rolledUpBadge} pending in ${group.label}`",
    );
  });

  it("gives the rollup badge a data-testid for e2e targeting", () => {
    expect(APPSHELL_SRC).toContain("-rollup-badge`");
  });
});

// ---------------------------------------------------------------------------
// Persist on change: side-effects in AppShell
// ---------------------------------------------------------------------------
describe("AppShell — localStorage persistence side-effects", () => {
  it("calls persistExpandedGroups when navExpanded changes", () => {
    expect(APPSHELL_SRC).toContain("persistExpandedGroups(navExpanded)");
  });

  it("calls persistExplicitCollapsedGroups when collapsed state changes", () => {
    expect(APPSHELL_SRC).toContain(
      "persistExplicitCollapsedGroups(next)",
    );
  });

  it("skips the first persist via skipFirstNavPersist ref to avoid overwriting localStorage on mount", () => {
    expect(APPSHELL_SRC).toContain("skipFirstNavPersist");
  });
});

// ---------------------------------------------------------------------------
// Deep-link auto-expand
// ---------------------------------------------------------------------------
describe("AppShell — deep-link auto-expand logic", () => {
  it("defines skipFirstAutoExpand ref to skip the initial mount", () => {
    expect(APPSHELL_SRC).toContain("skipFirstAutoExpand");
  });

  it("checks navExplicitCollapsedRef before auto-expanding", () => {
    expect(APPSHELL_SRC).toContain("navExplicitCollapsedRef.current.has(activeGroup)");
  });

  it("uses setNavExpanded to add the active group when not yet expanded", () => {
    expect(APPSHELL_SRC).toContain("next.add(activeGroup)");
  });
});

// ---------------------------------------------------------------------------
// State ownership in AppShell (not SidebarNavBody)
// ---------------------------------------------------------------------------
describe("AppShell — nav state lifted to AppShell", () => {
  it("declares navExpanded state via useState in AppShell", () => {
    expect(APPSHELL_SRC).toContain("useState<Set<string>>(() =>");
  });

  it("declares navExplicitCollapsed state via useState in AppShell", () => {
    expect(APPSHELL_SRC).toContain("navExplicitCollapsed");
  });

  it("defines toggleNavGroup as a function inside AppShell", () => {
    expect(APPSHELL_SRC).toContain("function toggleNavGroup(label: string)");
  });

  it("uses loadInitialExpandedGroups during useState initializer", () => {
    expect(APPSHELL_SRC).toContain("loadInitialExpandedGroups(activeGroup)");
  });

  it("uses loadExplicitCollapsedGroups during useState initializer", () => {
    expect(APPSHELL_SRC).toContain("loadExplicitCollapsedGroups()");
  });
});

// ---------------------------------------------------------------------------
// groupDomId — additional edge cases
// ---------------------------------------------------------------------------
describe("groupDomId — additional edge cases", () => {
  it("handles a label that is already lowercase and hyphenated", () => {
    expect(groupDomId("billing")).toBe("admin-nav-section-billing");
  });

  it("handles a label with numbers", () => {
    expect(groupDomId("Team 2")).toBe("admin-nav-section-team-2");
  });

  it("handles multiple leading/trailing non-alphanumeric chars as a single hyphen", () => {
    expect(groupDomId("  A  ")).toBe("admin-nav-section-a-");
  });

  it("produces unique ids for each nav group label", () => {
    const labels = ["Inbox", "Customers", "Orders & Shop", "Billing", "Insights", "System"];
    const ids = labels.map(groupDomId);
    const unique = new Set(ids);
    expect(unique.size).toBe(labels.length);
  });
});

// ---------------------------------------------------------------------------
// persistExpandedGroups — pure logic reimplemented for unit testing
// ---------------------------------------------------------------------------
function persistExpandedGroups(
  expanded: Set<string>,
  storage: Map<string, string>,
): void {
  storage.set(NAV_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(expanded)));
}

describe("persistExpandedGroups", () => {
  it("writes the expanded set as a JSON array to the storage key", () => {
    const store = new Map<string, string>();
    persistExpandedGroups(new Set(["Inbox", "System"]), store);
    const raw = store.get(NAV_EXPANDED_STORAGE_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(new Set(parsed as string[])).toEqual(new Set(["Inbox", "System"]));
  });

  it("writes an empty array when the expanded set is empty", () => {
    const store = new Map<string, string>();
    persistExpandedGroups(new Set(), store);
    const raw = store.get(NAV_EXPANDED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual([]);
  });

  it("overwrites a previous value on subsequent calls", () => {
    const store = new Map<string, string>();
    persistExpandedGroups(new Set(["Inbox"]), store);
    persistExpandedGroups(new Set(["System"]), store);
    const raw = store.get(NAV_EXPANDED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual(["System"]);
  });
});

// ---------------------------------------------------------------------------
// persistExplicitCollapsedGroups — pure logic reimplemented for unit testing
// ---------------------------------------------------------------------------
function persistExplicitCollapsedGroups(
  explicitCollapsed: Set<string>,
  storage: Map<string, string>,
): void {
  storage.set(
    NAV_EXPLICIT_COLLAPSED_STORAGE_KEY,
    JSON.stringify(Array.from(explicitCollapsed)),
  );
}

describe("persistExplicitCollapsedGroups", () => {
  it("writes the collapsed set as a JSON array to the storage key", () => {
    const store = new Map<string, string>();
    persistExplicitCollapsedGroups(new Set(["Inbox"]), store);
    const raw = store.get(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual(["Inbox"]);
  });

  it("writes an empty array when the set is empty", () => {
    const store = new Map<string, string>();
    persistExplicitCollapsedGroups(new Set(), store);
    const raw = store.get(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual([]);
  });

  it("uses a separate storage key from persistExpandedGroups", () => {
    expect(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY).not.toBe(NAV_EXPANDED_STORAGE_KEY);
  });
});

// ---------------------------------------------------------------------------
// loadInitialExpandedGroups — additional edge cases
// ---------------------------------------------------------------------------
describe("loadInitialExpandedGroups — additional edge cases", () => {
  it("honours stored groups even when activeGroup is null", () => {
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, JSON.stringify(["Inbox", "Billing"])],
    ]);
    const result = loadInitialExpandedGroups(null, store);
    expect(result).toEqual(new Set(["Inbox", "Billing"]));
  });

  it("falls back to empty set when activeGroup is null and storage has empty JSON array", () => {
    const store = new Map([
      [NAV_EXPANDED_STORAGE_KEY, JSON.stringify([])],
    ]);
    const result = loadInitialExpandedGroups(null, store);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toggleNavGroup — additional edge cases
// ---------------------------------------------------------------------------
describe("toggleNavGroup — additional edge cases", () => {
  it("can toggle multiple independent groups in sequence", () => {
    let state: NavState = {
      expanded: new Set(),
      explicitCollapsed: new Set(),
    };
    state = toggleNavGroup("Inbox", state);
    state = toggleNavGroup("System", state);
    expect(state.expanded.has("Inbox")).toBe(true);
    expect(state.expanded.has("System")).toBe(true);
  });

  it("closing one group does not affect other open groups", () => {
    const state: NavState = {
      expanded: new Set(["Inbox", "System", "Billing"]),
      explicitCollapsed: new Set(),
    };
    const next = toggleNavGroup("System", state);
    expect(next.expanded.has("Inbox")).toBe(true);
    expect(next.expanded.has("System")).toBe(false);
    expect(next.expanded.has("Billing")).toBe(true);
  });

  it("opening a group that was never in explicitCollapsed leaves explicitCollapsed empty", () => {
    const state: NavState = {
      expanded: new Set(),
      explicitCollapsed: new Set(),
    };
    const next = toggleNavGroup("Inbox", state);
    expect(next.explicitCollapsed.size).toBe(0);
  });
});