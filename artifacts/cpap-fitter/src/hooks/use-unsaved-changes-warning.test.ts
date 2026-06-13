// Tests for hooks/use-unsaved-changes-warning.ts.
//
// The hook is intentionally tiny, but it owns a high-risk workflow: preventing
// accidental data loss when a form is dirty. Static checks keep the guard logic
// from drifting during refactors.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "use-unsaved-changes-warning.ts"),
  "utf8",
);

describe("useUnsavedChangesWarning", () => {
  it("exports the hook", () => {
    expect(SRC).toContain("export function useUnsavedChangesWarning");
  });

  it("keeps the browser beforeunload guard for reloads and tab close", () => {
    expect(SRC).toContain('window.addEventListener("beforeunload"');
    expect(SRC).toContain("e.preventDefault()");
    expect(SRC).toContain('e.returnValue = ""');
    expect(SRC).toContain('window.removeEventListener("beforeunload"');
  });

  it("guards same-origin anchor clicks before the router handles them", () => {
    expect(SRC).toContain('document.addEventListener("click"');
    expect(SRC).toContain('target.closest("a[href]")');
    expect(SRC).toContain("isSameOriginNavigation");
    expect(SRC).toContain("confirmDiscardUnsavedChanges(message)");
  });

  it("prevents navigation when the user cancels discard", () => {
    expect(SRC).toContain("e.preventDefault()");
    expect(SRC).toContain("e.stopPropagation()");
  });

  it("ignores modified, external, download, and hash-only clicks", () => {
    expect(SRC).toContain("event.metaKey");
    expect(SRC).toContain('anchor.hasAttribute("download")');
    expect(SRC).toContain("url.origin !== window.location.origin");
    expect(SRC).toContain(
      "url.pathname === current.pathname && url.search === current.search",
    );
  });
});
