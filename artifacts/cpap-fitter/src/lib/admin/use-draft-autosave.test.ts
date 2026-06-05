// Tests for lib/admin/use-draft-autosave.ts
//
// The vitest environment is "node" (no jsdom) and the repo convention is
// NOT to render hooks; for hooks whose logic lives in effects we assert
// structural invariants on the source instead (mirrors
// hooks/use-url-state.test.ts). These pin the key-switch write guard that
// keeps one conversation's draft from being persisted under another's key.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "use-draft-autosave.ts"), "utf8");

describe("use-draft-autosave — key-switch write guard", () => {
  it("tracks the armed write key in a ref", () => {
    expect(SRC).toContain("writeKeyRef");
    expect(SRC).toContain("useRef(key)");
  });

  it("skips the debounced write on the run where the key just changed", () => {
    // The guard must short-circuit before scheduling the setTimeout so a
    // stale (newKey, oldValue) pair is never written.
    expect(SRC).toMatch(/if\s*\(\s*writeKeyRef\.current\s*!==\s*key\s*\)/);
  });

  it("still debounces the write and clears the timer on cleanup", () => {
    expect(SRC).toContain("setTimeout");
    expect(SRC).toContain("clearTimeout");
  });
});
