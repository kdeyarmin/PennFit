// Tests for components/admin/SelectionCheckbox.tsx
//
// The vitest environment for cpap-fitter is "node" (no DOM, no React
// rendering). We use the source-analysis pattern to verify the
// structural invariants of both checkbox variants.
//
// Invariants under test:
//   - Public exports: HeaderSelectionCheckbox, RowSelectionCheckbox.
//   - HeaderSelectionCheckbox: checked = allSelected.
//   - Indeterminate logic: !allSelected && someSelected set via ref callback.
//   - Click stopPropagation — both variants stop clicks from bubbling
//     up to row-click handlers.
//   - RowSelectionCheckbox: checked from prop, ariaLabel required.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "SelectionCheckbox.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("SelectionCheckbox — exports", () => {
  it("exports HeaderSelectionCheckbox", () => {
    expect(SRC).toContain("export function HeaderSelectionCheckbox");
  });

  it("exports RowSelectionCheckbox", () => {
    expect(SRC).toContain("export function RowSelectionCheckbox");
  });
});

// ---------------------------------------------------------------------------
// HeaderSelectionCheckbox — checked and indeterminate state
// ---------------------------------------------------------------------------

describe("HeaderSelectionCheckbox — checked and indeterminate", () => {
  it("binds checked to the allSelected prop", () => {
    expect(SRC).toContain("checked={allSelected}");
  });

  it("sets el.indeterminate = !allSelected && someSelected via ref callback", () => {
    // indeterminate is a DOM property, not a React attribute. The
    // component must use a ref callback to set it imperatively.
    expect(SRC).toContain("el.indeterminate = !allSelected && someSelected");
  });

  it("uses a ref callback guarded by `if (el)`", () => {
    // The ref may be null on unmount; the guard prevents a null-dereference.
    expect(SRC).toMatch(/ref=\{\(el\) => \{[\s\S]*?if \(el\)/);
  });

  it("triggers onChange with onToggle", () => {
    expect(SRC).toContain("onChange={onToggle}");
  });
});

// ---------------------------------------------------------------------------
// Click propagation stop — both variants
// ---------------------------------------------------------------------------

describe("SelectionCheckbox — stopPropagation on click", () => {
  it("HeaderSelectionCheckbox stops click propagation", () => {
    // Without stopPropagation the checkbox click would also trigger
    // the column header's sort handler or the row click handler.
    const headerFnStart = SRC.indexOf(
      "export function HeaderSelectionCheckbox",
    );
    const rowFnStart = SRC.indexOf("export function RowSelectionCheckbox");
    const headerSrc = SRC.slice(headerFnStart, rowFnStart);
    expect(headerSrc).toContain("e.stopPropagation()");
  });

  it("RowSelectionCheckbox stops click propagation", () => {
    // Without stopPropagation the checkbox click in a row would trigger
    // the row's onRowClick navigation to the detail page.
    const rowFnStart = SRC.indexOf("export function RowSelectionCheckbox");
    const rowSrc = SRC.slice(rowFnStart);
    expect(rowSrc).toContain("e.stopPropagation()");
  });

  it("both variants use onClick={(e) => e.stopPropagation()}", () => {
    const occurrences = (SRC.match(/e\.stopPropagation\(\)/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// RowSelectionCheckbox — checked state and required ariaLabel
// ---------------------------------------------------------------------------

describe("RowSelectionCheckbox — checked and ariaLabel", () => {
  it("binds checked to the checked prop", () => {
    const rowFnStart = SRC.indexOf("export function RowSelectionCheckbox");
    const rowSrc = SRC.slice(rowFnStart);
    expect(rowSrc).toContain("checked={checked}");
  });

  it("requires ariaLabel (annotated in JSDoc as required for screen readers)", () => {
    // The comment explains that per-row labels are required for a11y.
    expect(SRC).toContain(
      "Required — screen readers need a per-row label to disambiguate",
    );
    // The prop must NOT have a default value (it is mandatory). Scope
    // the regex to the RowSelectionCheckbox function body only — the
    // sibling HeaderSelectionCheckbox legitimately defaults its
    // ariaLabel because "Select all on this page" is the right
    // header copy with no per-row ambiguity.
    const rowFnStart = SRC.indexOf("export function RowSelectionCheckbox");
    const rowSrc = SRC.slice(rowFnStart);
    expect(rowSrc).not.toMatch(/ariaLabel\s*=\s*"/);
  });

  it("applies the ariaLabel prop as aria-label", () => {
    const rowFnStart = SRC.indexOf("export function RowSelectionCheckbox");
    const rowSrc = SRC.slice(rowFnStart);
    expect(rowSrc).toContain("aria-label={ariaLabel}");
  });
});

// ---------------------------------------------------------------------------
// HeaderSelectionCheckbox — default ariaLabel
// ---------------------------------------------------------------------------

describe("HeaderSelectionCheckbox — default ariaLabel", () => {
  it("defaults ariaLabel to 'Select all on this page'", () => {
    expect(SRC).toContain('ariaLabel = "Select all on this page"');
  });
});

// ---------------------------------------------------------------------------
// Shared cursor style
// ---------------------------------------------------------------------------

describe("SelectionCheckbox — cursor style", () => {
  it("applies CHECKBOX_STYLE (cursor: pointer) to both inputs", () => {
    // Both variants reference the shared constant so the cursor is
    // consistent and the style is defined once.
    expect(SRC).toContain("const CHECKBOX_STYLE");
    expect(SRC).toContain('cursor: "pointer"');
    // Both variants reference it.
    const styleOccurrences = (SRC.match(/style=\{CHECKBOX_STYLE\}/g) ?? [])
      .length;
    expect(styleOccurrences).toBe(2);
  });
});
