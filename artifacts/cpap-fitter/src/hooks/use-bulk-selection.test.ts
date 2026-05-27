// Tests for hooks/use-bulk-selection.ts
//
// The vitest environment is "node" (no DOM, no React rendering), so
// we follow the same pattern as use-url-state.test.ts:
//   1. Source-analysis assertions on the React-wiring layer to catch
//      regressions in hook composition.
//   2. Exhaustive unit tests on the pure helpers that own the
//      state-transition logic.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  computeAllVisibleSelected,
  computeSomeVisibleSelected,
  computeToggledAllVisible,
  computeToggledOne,
  pruneToVisible,
} from "./use-bulk-selection";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "use-bulk-selection.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Structural checks — guard the React wiring layer.
// ---------------------------------------------------------------------------

describe("use-bulk-selection — exports", () => {
  it("exports the useBulkSelection hook", () => {
    expect(SRC).toContain("export function useBulkSelection");
  });
  it("exports the pure helpers used by tests + future consumers", () => {
    for (const sym of [
      "computeToggledOne",
      "computeToggledAllVisible",
      "pruneToVisible",
      "computeAllVisibleSelected",
      "computeSomeVisibleSelected",
    ]) {
      expect(SRC).toContain(`export function ${sym}`);
    }
  });
});

describe("use-bulk-selection — React wiring", () => {
  it("prunes off-screen ids in a useEffect so stale selection can't survive pagination", () => {
    // The effect must call setSelectedIds with pruneToVisible — otherwise
    // a "Pause N" click after pagination would target ghosts.
    expect(SRC).toMatch(/useEffect\([\s\S]*pruneToVisible[\s\S]*visibleIds/);
  });
  it("setSelectedIds is initialised lazily so we don't allocate a new Set per render", () => {
    expect(SRC).toMatch(/useState[\s\S]*\(\) => new Set\(\)/);
  });
});

// ---------------------------------------------------------------------------
// computeToggledOne — adds/removes one id.
// ---------------------------------------------------------------------------

describe("computeToggledOne", () => {
  it("adds an id that isn't present", () => {
    const out = computeToggledOne(new Set(["a"]), "b");
    expect(Array.from(out).sort()).toEqual(["a", "b"]);
  });
  it("removes an id that is present", () => {
    const out = computeToggledOne(new Set(["a", "b"]), "a");
    expect(Array.from(out)).toEqual(["b"]);
  });
  it("returns a fresh Set (never mutates the input)", () => {
    const input = new Set(["a"]);
    const out = computeToggledOne(input, "b");
    expect(out).not.toBe(input);
    expect(Array.from(input)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// computeToggledAllVisible — bulk select / deselect visible page.
// ---------------------------------------------------------------------------

describe("computeToggledAllVisible", () => {
  it("selects every visible id when none is selected", () => {
    const out = computeToggledAllVisible(new Set(), ["a", "b", "c"]);
    expect(Array.from(out).sort()).toEqual(["a", "b", "c"]);
  });
  it("selects every visible id when some (but not all) are selected", () => {
    const out = computeToggledAllVisible(new Set(["a"]), ["a", "b", "c"]);
    expect(Array.from(out).sort()).toEqual(["a", "b", "c"]);
  });
  it("clears the visible portion when all visible are selected", () => {
    const out = computeToggledAllVisible(
      new Set(["a", "b", "c"]),
      ["a", "b", "c"],
    );
    expect(Array.from(out)).toEqual([]);
  });
  it("preserves selections that aren't on the visible page (clear branch)", () => {
    // "x" is selected but not visible — must survive the visible-clear.
    const out = computeToggledAllVisible(
      new Set(["a", "b", "x"]),
      ["a", "b"],
    );
    expect(Array.from(out)).toEqual(["x"]);
  });
  it("preserves off-page selections in the select branch too", () => {
    const out = computeToggledAllVisible(new Set(["x"]), ["a", "b"]);
    expect(Array.from(out).sort()).toEqual(["a", "b", "x"]);
  });
  it("no-op on an empty visible page", () => {
    const out = computeToggledAllVisible(new Set(["x"]), []);
    expect(Array.from(out)).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
// pruneToVisible — drop off-page ids.
// ---------------------------------------------------------------------------

describe("pruneToVisible", () => {
  it("returns the same Set identity when there's nothing to drop", () => {
    const input = new Set(["a", "b"]);
    const out = pruneToVisible(input, ["a", "b", "c"]);
    // Identity-stable: the useState bail-out depends on this.
    expect(out).toBe(input);
  });
  it("returns the same Set identity when the selection is empty", () => {
    const input = new Set<string>();
    const out = pruneToVisible(input, ["a", "b", "c"]);
    expect(out).toBe(input);
  });
  it("drops ids that aren't in visibleIds", () => {
    const out = pruneToVisible(new Set(["a", "b", "x"]), ["a", "b", "c"]);
    expect(Array.from(out).sort()).toEqual(["a", "b"]);
  });
  it("drops everything when the visible page is empty", () => {
    const out = pruneToVisible(new Set(["a", "b"]), []);
    expect(Array.from(out)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Derived booleans — drive header checkbox + indeterminate state.
// ---------------------------------------------------------------------------

describe("computeAllVisibleSelected", () => {
  it("true when every visible id is in the selection", () => {
    expect(
      computeAllVisibleSelected(["a", "b"], new Set(["a", "b", "c"])),
    ).toBe(true);
  });
  it("false when one visible id is missing", () => {
    expect(computeAllVisibleSelected(["a", "b"], new Set(["a"]))).toBe(false);
  });
  it("false when the visible page is empty (avoids ✓-on-empty UI)", () => {
    expect(computeAllVisibleSelected([], new Set(["a"]))).toBe(false);
  });
});

describe("computeSomeVisibleSelected", () => {
  it("true when at least one visible id is selected", () => {
    expect(computeSomeVisibleSelected(["a", "b"], new Set(["a"]))).toBe(true);
  });
  it("false when no visible id is selected", () => {
    expect(computeSomeVisibleSelected(["a", "b"], new Set(["x"]))).toBe(false);
  });
  it("false on an empty visible page", () => {
    expect(computeSomeVisibleSelected([], new Set(["a"]))).toBe(false);
  });
});
