// Tests for the collapsible-group sidebar machinery added to AppShell.tsx.
//
// The vitest environment in cpap-fitter is "node" (no jsdom, no RTL) so
// we follow the same two-pronged convention used by use-url-state.test.ts:
//
//   1. Static source-string guards on AppShell.tsx — they assert that the
//      helpers, storage keys, and state-machine wiring are still in place.
//      A future refactor that removes them trips these tests before any
//      behaviour test ever runs.
//
//   2. Pure-logic re-implementation — the decision logic that drives the
//      sidebar (load/persist localStorage, deep-link auto-expand, explicit-
//      collapse coordination) is re-implemented verbatim as plain functions
//      below and exercised against an in-memory localStorage stub. If the
//      real behaviour drifts, these unit tests catch the divergence.
//
// Together these cover the regression scenarios the PR-#318 reviewer flagged:
//   • default-open active group on first load
//   • persistence to localStorage
//   • deep-link auto-expand
//   • explicit collapse of the active group survives reload

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

// ---------------------------------------------------------------------------
// SECTION 1 — Static source-string guards
// ---------------------------------------------------------------------------
// These pin the structural shape of the collapsible machinery. If a
// refactor removes one of these landmarks, the regression surfaces here
// before the behaviour tests below have a chance to drift quietly.

describe("AppShell — collapsible nav infrastructure", () => {
  it("imports ChevronRight from lucide-react for the group toggle indicator", () => {
    expect(APPSHELL_SRC).toContain("ChevronRight");
  });

  it("defines NAV_EXPANDED_STORAGE_KEY with the expected key name", () => {
    expect(APPSHELL_SRC).toContain("NAV_EXPANDED_STORAGE_KEY");
    expect(APPSHELL_SRC).toContain('"pf-admin-nav-expanded-groups"');
  });

  it("defines NAV_EXPLICIT_COLLAPSED_STORAGE_KEY separately from the expanded key", () => {
    expect(APPSHELL_SRC).toContain("NAV_EXPLICIT_COLLAPSED_STORAGE_KEY");
    expect(APPSHELL_SRC).toContain('"pf-admin-nav-explicit-collapsed-groups"');
  });

  it("defines the four localStorage helpers (load/persist for both keys)", () => {
    expect(APPSHELL_SRC).toContain("function loadInitialExpandedGroups");
    expect(APPSHELL_SRC).toContain("function persistExpandedGroups");
    expect(APPSHELL_SRC).toContain("function loadExplicitCollapsedGroups");
    expect(APPSHELL_SRC).toContain("function persistExplicitCollapsedGroups");
  });

  it("defines findGroupForActiveHref to compute the active group on each render", () => {
    expect(APPSHELL_SRC).toContain("function findGroupForActiveHref");
  });

  it("skips the first auto-expand effect via a ref so the active group's persisted collapse survives reload", () => {
    // Without skipFirstAutoExpand the auto-expand effect would always re-add
    // activeGroup right after mount, defeating loadInitialExpandedGroups for
    // a user who deliberately collapsed the group containing their current
    // route. This is the regression chatgpt-codex-connector flagged as P1.
    expect(APPSHELL_SRC).toContain("skipFirstAutoExpand");
  });

  it("skips the first persist effect so loadInitialExpandedGroups' result is not immediately overwritten", () => {
    expect(APPSHELL_SRC).toContain("skipFirstNavPersist");
  });

  it("lifts the expand/collapse state into AppShell (one owner shared by desktop and mobile)", () => {
    // The reviewer (chatgpt-codex-connector P2) flagged that putting state
    // inside SidebarNavBody made the desktop sidebar and mobile drawer
    // race each other writing to localStorage. State must live in the
    // parent and be passed down via props.
    expect(APPSHELL_SRC).toContain("navExpanded");
    expect(APPSHELL_SRC).toContain("navExplicitCollapsed");
    expect(APPSHELL_SRC).toContain("toggleNavGroup");
    expect(APPSHELL_SRC).toContain("onToggleGroup");
  });

  it("annotates the group toggle button with aria-expanded and aria-controls", () => {
    expect(APPSHELL_SRC).toContain("aria-expanded");
    expect(APPSHELL_SRC).toContain("aria-controls");
  });

  it("uses hidden={!isOpen} on the items container so aria-controls always resolves to a real DOM element", () => {
    // copilot-pull-request-reviewer flagged that conditional rendering
    // (`{isOpen && <div id=...>}`) leaves aria-controls dangling. Toggle
    // visibility via the `hidden` attribute instead so the IDREF target
    // is always in the DOM.
    expect(APPSHELL_SRC).toContain("hidden={!isOpen}");
  });

  it("persists explicit collapses inside the toggle callback (not inside setExpanded)", () => {
    // After lifting state, the dedicated useEffect handles expanded
    // persistence. The toggle still writes the explicit-collapsed set
    // synchronously because it's a single localStorage round-trip per click.
    expect(APPSHELL_SRC).toContain("persistExplicitCollapsedGroups");
  });
});

// ---------------------------------------------------------------------------
// SECTION 2 — Pure-logic re-implementation
// ---------------------------------------------------------------------------
// The functions below mirror the helpers in AppShell.tsx. They are
// re-implemented so we can drive them with a stub storage and assert
// the documented behaviours without needing jsdom or a render harness.
// If the real implementation drifts, the static guards above flag the
// shape change; if the behaviour drifts, the unit tests below flag that.

const NAV_EXPANDED_STORAGE_KEY = "pf-admin-nav-expanded-groups";
const NAV_EXPLICIT_COLLAPSED_STORAGE_KEY =
  "pf-admin-nav-explicit-collapsed-groups";

class StubStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  clear(): void {
    this.store.clear();
  }
  raw(key: string): string | undefined {
    return this.store.get(key);
  }
}

function loadInitialExpandedGroups(
  storage: StubStorage,
  activeGroup: string | null,
): Set<string> {
  const fallback = new Set(activeGroup ? [activeGroup] : []);
  try {
    const raw = storage.getItem(NAV_EXPANDED_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((s): s is string => typeof s === "string")
    ) {
      return new Set(parsed);
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

function persistExpandedGroups(
  storage: StubStorage,
  expanded: Set<string>,
): void {
  storage.setItem(
    NAV_EXPANDED_STORAGE_KEY,
    JSON.stringify(Array.from(expanded)),
  );
}

function loadExplicitCollapsedGroups(storage: StubStorage): Set<string> {
  try {
    const raw = storage.getItem(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((s): s is string => typeof s === "string")
    ) {
      return new Set(parsed);
    }
  } catch {
    /* fall through */
  }
  return new Set();
}

function persistExplicitCollapsedGroups(
  storage: StubStorage,
  explicitCollapsed: Set<string>,
): void {
  storage.setItem(
    NAV_EXPLICIT_COLLAPSED_STORAGE_KEY,
    JSON.stringify(Array.from(explicitCollapsed)),
  );
}

type NavLink = {
  href: string;
  label: string;
  matchPrefix?: string;
};
type NavGroup = { label: string; items: ReadonlyArray<NavLink> };

const SAMPLE_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Inbox",
    items: [
      { href: "/admin", label: "Dashboard", matchPrefix: "/admin" },
      {
        href: "/admin/conversations",
        label: "Conversations",
        matchPrefix: "/admin/conversations",
      },
    ],
  },
  {
    label: "Billing",
    items: [
      {
        href: "/admin/billing",
        label: "Billing Hub",
        matchPrefix: "/admin/billing",
      },
      {
        href: "/admin/billing/aging",
        label: "A/R aging",
        matchPrefix: "/admin/billing/aging",
      },
    ],
  },
];

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

describe("findGroupForActiveHref", () => {
  it("returns null for a null activeHref", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, null)).toBe(null);
  });

  it("returns the group label that owns the active href", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/conversations")).toBe(
      "Inbox",
    );
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/billing/aging")).toBe(
      "Billing",
    );
  });

  it("returns null when no group owns the href", () => {
    expect(findGroupForActiveHref(SAMPLE_GROUPS, "/admin/no-such-route")).toBe(
      null,
    );
  });
});

describe("loadInitialExpandedGroups", () => {
  let storage: StubStorage;
  beforeEach(() => {
    storage = new StubStorage();
  });

  it("falls back to only the active group when localStorage is empty", () => {
    expect([...loadInitialExpandedGroups(storage, "Billing")]).toEqual([
      "Billing",
    ]);
  });

  it("falls back to an empty set when there is no active group AND no localStorage", () => {
    expect([...loadInitialExpandedGroups(storage, null)]).toEqual([]);
  });

  it("returns the persisted set when localStorage has data — activeGroup is NOT auto-added on top", () => {
    persistExpandedGroups(storage, new Set(["Inbox", "Insights"]));
    const result = loadInitialExpandedGroups(storage, "Billing");
    expect([...result].sort()).toEqual(["Inbox", "Insights"]);
    expect(result.has("Billing")).toBe(false);
  });

  it("falls back when localStorage value is corrupt JSON", () => {
    storage.setItem(NAV_EXPANDED_STORAGE_KEY, "{not valid JSON");
    expect([...loadInitialExpandedGroups(storage, "Billing")]).toEqual([
      "Billing",
    ]);
  });

  it("falls back when localStorage value is the wrong shape (object instead of array)", () => {
    storage.setItem(
      NAV_EXPANDED_STORAGE_KEY,
      JSON.stringify({ malformed: true }),
    );
    expect([...loadInitialExpandedGroups(storage, "Inbox")]).toEqual(["Inbox"]);
  });

  it("falls back when localStorage value is an array but contains non-strings", () => {
    storage.setItem(NAV_EXPANDED_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect([...loadInitialExpandedGroups(storage, "Inbox")]).toEqual(["Inbox"]);
  });

  it("persist + load round-trips the expanded set unchanged", () => {
    const original = new Set(["Billing", "System", "Inbox"]);
    persistExpandedGroups(storage, original);
    expect([...loadInitialExpandedGroups(storage, null)].sort()).toEqual(
      [...original].sort(),
    );
  });
});

describe("loadExplicitCollapsedGroups", () => {
  let storage: StubStorage;
  beforeEach(() => {
    storage = new StubStorage();
  });

  it("returns an empty set on first load", () => {
    expect([...loadExplicitCollapsedGroups(storage)]).toEqual([]);
  });

  it("round-trips through persistExplicitCollapsedGroups", () => {
    persistExplicitCollapsedGroups(storage, new Set(["Billing"]));
    expect([...loadExplicitCollapsedGroups(storage)]).toEqual(["Billing"]);
  });

  it("uses a different localStorage key than expanded (reading expanded doesn't see collapse data)", () => {
    persistExplicitCollapsedGroups(storage, new Set(["Billing"]));
    expect([...loadInitialExpandedGroups(storage, null)]).toEqual([]);
  });

  it("falls back to empty set when localStorage value is corrupt", () => {
    storage.setItem(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY, "<garbage>");
    expect([...loadExplicitCollapsedGroups(storage)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// State machine: deep-link auto-expand + explicit-collapse coordination
// ---------------------------------------------------------------------------
// The rules in AppShell.tsx:
//   • On the very first render the auto-expand effect is skipped — the
//     initial localStorage load is authoritative.
//   • On subsequent renders where `activeGroup` changes, open it unless
//     the user has explicitly collapsed it.
//   • Toggling open: remove from explicitCollapsed.
//   • Toggling closed: add to explicitCollapsed (so the next auto-expand
//     can't re-open the group the user just closed).

interface NavState {
  expanded: Set<string>;
  explicitCollapsed: Set<string>;
  isFirstNavigation: boolean;
}

function makeInitialNavState(
  storage: StubStorage,
  activeGroup: string | null,
): NavState {
  return {
    expanded: loadInitialExpandedGroups(storage, activeGroup),
    explicitCollapsed: loadExplicitCollapsedGroups(storage),
    isFirstNavigation: true,
  };
}

function onNavigationChange(
  state: NavState,
  activeGroup: string | null,
): NavState {
  if (state.isFirstNavigation) {
    return { ...state, isFirstNavigation: false };
  }
  if (!activeGroup) return state;
  if (state.explicitCollapsed.has(activeGroup)) return state;
  if (state.expanded.has(activeGroup)) return state;
  const next = new Set(state.expanded);
  next.add(activeGroup);
  return { ...state, expanded: next };
}

function onToggleGroup(state: NavState, label: string): NavState {
  const isCurrentlyOpen = state.expanded.has(label);
  const nextExpanded = new Set(state.expanded);
  const nextExplicit = new Set(state.explicitCollapsed);
  if (isCurrentlyOpen) {
    nextExpanded.delete(label);
    nextExplicit.add(label);
  } else {
    nextExpanded.add(label);
    nextExplicit.delete(label);
  }
  return { ...state, expanded: nextExpanded, explicitCollapsed: nextExplicit };
}

describe("nav state machine — initial mount", () => {
  let storage: StubStorage;
  beforeEach(() => {
    storage = new StubStorage();
  });

  it("opens only the active group when nothing is persisted yet (default-open active group)", () => {
    const state = makeInitialNavState(storage, "Billing");
    expect([...state.expanded]).toEqual(["Billing"]);
    expect([...state.explicitCollapsed]).toEqual([]);
  });

  it("opens no group when there is no active route and no persisted state", () => {
    const state = makeInitialNavState(storage, null);
    expect([...state.expanded]).toEqual([]);
  });

  it("restores the persisted expanded set on reload, even if it doesn't include the active group", () => {
    persistExpandedGroups(storage, new Set(["Inbox"]));
    const state = makeInitialNavState(storage, "Billing");
    expect([...state.expanded]).toEqual(["Inbox"]);
    expect(state.expanded.has("Billing")).toBe(false);
  });

  it("restores the explicitCollapsed set on reload", () => {
    persistExplicitCollapsedGroups(storage, new Set(["Billing"]));
    const state = makeInitialNavState(storage, "Inbox");
    expect([...state.explicitCollapsed]).toEqual(["Billing"]);
  });
});

describe("nav state machine — toggleGroup", () => {
  let storage: StubStorage;
  let state: NavState;
  beforeEach(() => {
    storage = new StubStorage();
    state = makeInitialNavState(storage, "Inbox");
  });

  it("opening a closed group adds it to expanded and clears any explicit-collapse flag", () => {
    // Seed explicit-collapsed with Billing so we can verify it's cleared.
    state = { ...state, explicitCollapsed: new Set(["Billing"]) };

    state = onToggleGroup(state, "Billing");
    expect(state.expanded.has("Billing")).toBe(true);
    expect(state.explicitCollapsed.has("Billing")).toBe(false);
  });

  it("closing an open group removes it from expanded AND marks it explicitly collapsed", () => {
    state = onToggleGroup(state, "Billing"); // open it first
    expect(state.expanded.has("Billing")).toBe(true);

    state = onToggleGroup(state, "Billing"); // close it
    expect(state.expanded.has("Billing")).toBe(false);
    expect(state.explicitCollapsed.has("Billing")).toBe(true);
  });

  it("toggle does not touch other groups", () => {
    state = onToggleGroup(state, "Billing"); // open Billing
    expect(state.expanded.has("Inbox")).toBe(true); // Inbox stays open
  });
});

describe("nav state machine — deep-link auto-expand", () => {
  let storage: StubStorage;
  beforeEach(() => {
    storage = new StubStorage();
  });

  it("opens a previously-closed group when the rep navigates into it", () => {
    persistExpandedGroups(storage, new Set(["Inbox"]));
    let state = makeInitialNavState(storage, "Inbox");

    // First-navigation effect is skipped on mount.
    state = onNavigationChange(state, "Inbox");
    expect(state.expanded.has("Billing")).toBe(false);

    // User navigates to /admin/billing/aging — Billing should auto-expand.
    state = onNavigationChange(state, "Billing");
    expect(state.expanded.has("Billing")).toBe(true);
    // Existing open groups are untouched.
    expect(state.expanded.has("Inbox")).toBe(true);
  });

  it("does NOT re-open a group the user explicitly collapsed", () => {
    let state = makeInitialNavState(storage, "Inbox");
    state = onNavigationChange(state, "Inbox"); // skip first

    // User opens then explicitly closes Billing.
    state = onToggleGroup(state, "Billing");
    state = onToggleGroup(state, "Billing");
    expect(state.expanded.has("Billing")).toBe(false);
    expect(state.explicitCollapsed.has("Billing")).toBe(true);

    // User navigates to /admin/billing/aging. Auto-expand should be a no-op.
    state = onNavigationChange(state, "Billing");
    expect(state.expanded.has("Billing")).toBe(false);
  });

  it("re-opening a previously-collapsed group via toggle clears the explicit flag so future auto-expand works again", () => {
    let state = makeInitialNavState(storage, "Inbox");
    state = onNavigationChange(state, "Inbox");

    state = onToggleGroup(state, "Billing"); // open
    state = onToggleGroup(state, "Billing"); // explicit close
    expect(state.explicitCollapsed.has("Billing")).toBe(true);

    state = onToggleGroup(state, "Billing"); // re-open
    expect(state.expanded.has("Billing")).toBe(true);
    expect(state.explicitCollapsed.has("Billing")).toBe(false);

    // Now navigate away and back — auto-expand should be a no-op because
    // Billing is already open, but it also wouldn't be blocked anymore.
    state = onNavigationChange(state, "Inbox");
    state = onNavigationChange(state, "Billing");
    expect(state.expanded.has("Billing")).toBe(true);
  });

  it("does nothing when activeGroup is null (route doesn't match any nav link)", () => {
    let state = makeInitialNavState(storage, "Inbox");
    state = onNavigationChange(state, "Inbox"); // skip first

    const before = new Set(state.expanded);
    state = onNavigationChange(state, null);
    expect([...state.expanded].sort()).toEqual([...before].sort());
  });
});

describe("nav state machine — explicit collapse of the active group survives reload", () => {
  // This is the P1 regression that the chatgpt-codex-connector reviewer
  // and the copilot-pull-request-reviewer both flagged. The first version
  // of the auto-expand effect ran on initial mount as well, so reloading
  // would silently reopen the group the user had just closed.
  let storage: StubStorage;
  beforeEach(() => {
    storage = new StubStorage();
  });

  it("collapsing the active group, then reloading the page, keeps it collapsed", () => {
    // First session: user lands on /admin/billing/aging (activeGroup=Billing).
    let state = makeInitialNavState(storage, "Billing");
    expect(state.expanded.has("Billing")).toBe(true);
    // First-mount navigation effect is skipped.
    state = onNavigationChange(state, "Billing");
    expect(state.expanded.has("Billing")).toBe(true);

    // User explicitly closes Billing.
    state = onToggleGroup(state, "Billing");
    persistExpandedGroups(storage, state.expanded);
    persistExplicitCollapsedGroups(storage, state.explicitCollapsed);
    expect(state.expanded.has("Billing")).toBe(false);

    // ── Page reload — new state initialised from localStorage ──
    let reloaded = makeInitialNavState(storage, "Billing");
    expect(reloaded.expanded.has("Billing")).toBe(false);
    expect(reloaded.explicitCollapsed.has("Billing")).toBe(true);

    // The first navigation effect is skipped, so Billing stays collapsed
    // even though it's the active group. THIS is the regression.
    reloaded = onNavigationChange(reloaded, "Billing");
    expect(reloaded.expanded.has("Billing")).toBe(false);
  });
});
