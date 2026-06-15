// Tests for components/comm-prefs-section.tsx.
//
// The quiet-hours editor is a deferred-save surface. These structural checks
// make sure dirty edits are protected when the user leaves the Account tab.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "comm-prefs-section.tsx"),
  "utf8",
);

describe("CommPrefsSection dirty-state protection", () => {
  it("passes the account-level dirty callback into DndEditor", () => {
    expect(SRC).toContain("onDirtyChange?: (dirty: boolean) => void");
    expect(SRC).toContain("onDirtyChange={onDirtyChange}");
  });

  it("uses the shared unsaved-changes hook for quiet-hours edits", () => {
    expect(SRC).toContain("useUnsavedChangesWarning(dirty)");
  });

  it("reports dirty changes and clears them on unmount", () => {
    expect(SRC).toContain("onDirtyChange?.(dirty)");
    expect(SRC).toContain("return () => onDirtyChange?.(false)");
  });

  it("marks quiet-hours edits dirty before save", () => {
    expect(SRC).toContain("setDirty(true)");
    expect(SRC).toContain("Save quiet hours");
  });
});
