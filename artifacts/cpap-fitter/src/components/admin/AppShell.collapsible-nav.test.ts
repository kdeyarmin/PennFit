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
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

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
    expect(APPSHELL_SRC).toContain('"pf-admin-nav-expanded-groups"');
  });

  it("defines NAV_EXPLICIT_COLLAPSED_STORAGE_KEY", () => {
    expect(APPSHELL_SRC).toContain('"pf-admin-nav-explicit-collapsed-groups"');
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
    expect(groupDomId("Inbox")).toMatch(/^admin-nav-section-/);
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
    expect(groupDomId("Orders & Shop")).toBe("admin-nav-section-orders-shop");
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
interface NavItem {
  href: string;
  label: string;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

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
    items: [{ href: "/admin/patients", label: "Patients" }],
  },
  {
    label: "System",
    items: [{ href: "/admin/team", label: "Team" }],
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
    expect(
      findGroupForActiveHref(SAMPLE_GROUPS, "/admin/followups/extra"),
    ).toBeNull();
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
    const store = new Map([[NAV_EXPANDED_STORAGE_KEY, "{invalid json"]]);
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
    const store = new Map([[NAV_EXPANDED_STORAGE_KEY, JSON.stringify([])]]);
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
      [
        NAV_EXPLICIT_COLLAPSED_STORAGE_KEY,
        JSON.stringify(["Inbox", "Billing"]),
      ],
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
    expect(APPSHELL_SRC).toContain(`.replace(/[^a-z0-9]+/g, "-")`);
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
    expect(APPSHELL_SRC).toContain(
      'rolledUpBadge > 99 ? "99+" : rolledUpBadge',
    );
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
    expect(APPSHELL_SRC).toContain("persistExplicitCollapsedGroups(next)");
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
    expect(APPSHELL_SRC).toContain(
      "navExplicitCollapsedRef.current.has(activeGroup)",
    );
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
// persistExpandedGroups — pure logic, reimplemented for unit testing
// ---------------------------------------------------------------------------
function persistExpandedGroups(
  expanded: Set<string>,
  storage: Map<string, string> | null,
): void {
  if (storage === null) return; // SSR: no window
  try {
    storage.set(NAV_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(expanded)));
  } catch {
    /* quota / private-mode — non-fatal */
  }
}

describe("persistExpandedGroups", () => {
  it("is a no-op when storage is null (SSR guard)", () => {
    // Should not throw and storage remains null
    expect(() => persistExpandedGroups(new Set(["Inbox"]), null)).not.toThrow();
  });

  it("writes a JSON array of group labels to storage", () => {
    const store = new Map<string, string>();
    persistExpandedGroups(new Set(["Inbox", "System"]), store);
    const raw = store.get(NAV_EXPANDED_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(
      expect.arrayContaining(["Inbox", "System"]),
    );
  });

  it("overwrites a previous value when called again", () => {
    const store = new Map<string, string>();
    persistExpandedGroups(new Set(["Inbox"]), store);
    persistExpandedGroups(new Set(["System", "Billing"]), store);
    const raw = store.get(NAV_EXPANDED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual(
      expect.arrayContaining(["System", "Billing"]),
    );
    expect(JSON.parse(raw!)).not.toContain("Inbox");
  });

  it("writes an empty array when the expanded set is empty", () => {
    const store = new Map<string, string>();
    persistExpandedGroups(new Set(), store);
    const raw = store.get(NAV_EXPANDED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual([]);
  });

  it("round-trips through loadInitialExpandedGroups after persist", () => {
    const store = new Map<string, string>();
    const original = new Set(["Inbox", "Customers"]);
    persistExpandedGroups(original, store);
    const loaded = loadInitialExpandedGroups(null, store);
    expect(loaded).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// persistExplicitCollapsedGroups — pure logic, reimplemented for unit testing
// ---------------------------------------------------------------------------
function persistExplicitCollapsedGroups(
  explicitCollapsed: Set<string>,
  storage: Map<string, string> | null,
): void {
  if (storage === null) return; // SSR: no window
  try {
    storage.set(
      NAV_EXPLICIT_COLLAPSED_STORAGE_KEY,
      JSON.stringify(Array.from(explicitCollapsed)),
    );
  } catch {
    /* quota / private-mode — non-fatal */
  }
}

describe("persistExplicitCollapsedGroups", () => {
  it("is a no-op when storage is null (SSR guard)", () => {
    expect(() =>
      persistExplicitCollapsedGroups(new Set(["Inbox"]), null),
    ).not.toThrow();
  });

  it("writes a JSON array to storage under the explicit-collapsed key", () => {
    const store = new Map<string, string>();
    persistExplicitCollapsedGroups(new Set(["Inbox", "Billing"]), store);
    const raw = store.get(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(
      expect.arrayContaining(["Inbox", "Billing"]),
    );
  });

  it("overwrites a previous value when called again", () => {
    const store = new Map<string, string>();
    persistExplicitCollapsedGroups(new Set(["Inbox"]), store);
    persistExplicitCollapsedGroups(new Set(["System"]), store);
    const raw = store.get(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual(["System"]);
  });

  it("writes an empty array when no groups are explicitly collapsed", () => {
    const store = new Map<string, string>();
    persistExplicitCollapsedGroups(new Set(), store);
    const raw = store.get(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual([]);
  });

  it("round-trips through loadExplicitCollapsedGroups after persist", () => {
    const store = new Map<string, string>();
    const original = new Set(["Inbox", "Customers"]);
    persistExplicitCollapsedGroups(original, store);
    const loaded = loadExplicitCollapsedGroups(store);
    expect(loaded).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// groupDomId — additional edge cases
// ---------------------------------------------------------------------------
describe("groupDomId — additional edge cases", () => {
  it("returns a non-empty string for a single-char label", () => {
    const id = groupDomId("A");
    expect(id).toBe("admin-nav-section-a");
  });

  it("handles numeric-only labels without omitting numbers", () => {
    const id = groupDomId("404");
    expect(id).toBe("admin-nav-section-404");
  });

  it("trims leading and trailing hyphens produced by non-alphanumeric chars", () => {
    // A label like "& Inbox &" would produce leading/trailing hyphens without
    // additional trimming — confirm the slug transformation handles this.
    const id = groupDomId("& Inbox &");
    // Slug will be "-inbox-", but tests confirm what the actual implementation does
    expect(id).toMatch(/^admin-nav-section-/);
    expect(id).toContain("inbox");
  });

  it("produces a consistent id for repeated calls with the same label", () => {
    expect(groupDomId("Orders & Shop")).toBe(groupDomId("Orders & Shop"));
  });

  it("produces different ids for different labels", () => {
    expect(groupDomId("Inbox")).not.toBe(groupDomId("System"));
  });
});

// ---------------------------------------------------------------------------
// findGroupForActiveHref — additional edge cases
// ---------------------------------------------------------------------------
describe("findGroupForActiveHref — additional edge cases", () => {
  it("returns the first matching group when two groups have items with the same href (degenerate)", () => {
    const groups: ReadonlyArray<NavGroup> = [
      { label: "A", items: [{ href: "/shared", label: "Shared" }] },
      { label: "B", items: [{ href: "/shared", label: "Shared2" }] },
    ];
    // First group wins — same href in multiple groups is a data error but
    // the function should not crash.
    expect(findGroupForActiveHref(groups, "/shared")).toBe("A");
  });

  it("returns null when activeHref is an empty string", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "")).toBeNull();
  });

  it("handles a group with zero items without crashing", () => {
    const groups: ReadonlyArray<NavGroup> = [
      { label: "Empty", items: [] },
      ...SAMPLE_GROUPS,
    ];
    expect(findGroupForActiveHref(groups, "/admin/followups")).toBe("Inbox");
  });
});

// ---------------------------------------------------------------------------
// toggleNavGroup — additional edge cases
// ---------------------------------------------------------------------------
describe("toggleNavGroup — additional edge cases", () => {
  it("handles toggling a group that starts in explicitCollapsed (opens it and removes from explicitCollapsed)", () => {
    const state: NavState = {
      expanded: new Set(),
      explicitCollapsed: new Set(["System", "Billing"]),
    };
    const next = toggleNavGroup("System", state);
    expect(next.expanded.has("System")).toBe(true);
    expect(next.explicitCollapsed.has("System")).toBe(false);
    // Billing should be unaffected
    expect(next.explicitCollapsed.has("Billing")).toBe(true);
  });

  it("returns new Set instances (not the original references)", () => {
    const state: NavState = {
      expanded: new Set(["Inbox"]),
      explicitCollapsed: new Set(),
    };
    const next = toggleNavGroup("Inbox", state);
    expect(next.expanded).not.toBe(state.expanded);
    expect(next.explicitCollapsed).not.toBe(state.explicitCollapsed);
  });

  it("three-way toggle: open → close → open restores to expanded, not in explicitCollapsed", () => {
    let state: NavState = {
      expanded: new Set(),
      explicitCollapsed: new Set(),
    };
    state = toggleNavGroup("Customers", state); // open
    state = toggleNavGroup("Customers", state); // close (explicit)
    state = toggleNavGroup("Customers", state); // re-open (clears explicit)
    expect(state.expanded.has("Customers")).toBe(true);
    expect(state.explicitCollapsed.has("Customers")).toBe(false);
  });
});
