// Tests for hooks/use-document-title.tsx
//
// useDocumentTitle is a React hook that sets the browser tab title, meta
// description, canonical URL, Open Graph + Twitter Card tags, and optionally
// injects a JSON-LD <script type="application/ld+json"> for rich-snippet
// eligibility.
//
// Because the vitest environment is "node" (no jsdom), we cannot render the
// hook directly. We use static source analysis — readFileSync on the hook
// source — to assert structural invariants: the JSON-LD guard condition,
// the stable script ID, cleanup on unmount, and the stale-script removal
// logic that prevents duplicate scripts from accumulating across navigations.
//
// This mirrors the approach used by use-url-state.test.ts in this directory.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "use-document-title.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("use-document-title — exports", () => {
  it("exports the useDocumentTitle function", () => {
    expect(SRC).toContain("export function useDocumentTitle");
  });
});

// ---------------------------------------------------------------------------
// JSON-LD injection guard
//
// The hook must only emit the <script> block when all three of
// options.schema, pageTitle, and description are provided so that partial
// calls don't produce incomplete/invalid structured data.
// ---------------------------------------------------------------------------

describe("use-document-title — JSON-LD injection guard", () => {
  it("gates injection on options.schema being truthy", () => {
    expect(SRC).toContain("options?.schema");
  });

  it("gates injection on pageTitle being truthy", () => {
    // The guard must check all three: schema && pageTitle && description.
    // We verify pageTitle appears together with options?.schema in the guard.
    const guardLine = SRC
      .split("\n")
      .find((l) => l.includes("options?.schema") && l.includes("pageTitle"));
    expect(guardLine).toBeDefined();
  });

  it("gates injection on description being truthy", () => {
    const guardLine = SRC
      .split("\n")
      .find((l) => l.includes("options?.schema") && l.includes("description"));
    expect(guardLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Stable script ID
//
// The hook must give the injected <script> a stable id so that both the
// cleanup path and the stale-removal logic can find it by selector rather
// than by reference, guarding against stale scripts surviving HMR reloads
// or fast-refresh cycles.
// ---------------------------------------------------------------------------

describe("use-document-title — stable JSON-LD script ID", () => {
  it('assigns id "pf-page-schema" to the injected script element', () => {
    expect(SRC).toContain("pf-page-schema");
  });

  it("sets the id attribute on the script element via schemaScript.id", () => {
    expect(SRC).toContain("schemaScript.id");
  });
});

// ---------------------------------------------------------------------------
// Stale-script removal before insertion
//
// When the user navigates from one schema page to another, the hook re-runs
// with a new payload. It must remove any existing #pf-page-schema script
// before inserting the new one to prevent duplicate structured-data blocks.
// ---------------------------------------------------------------------------

describe("use-document-title — removes stale script before inserting", () => {
  it("queries for an existing pf-page-schema script before creating a new one", () => {
    expect(SRC).toContain('script[type="application/ld+json"]#pf-page-schema');
  });

  it("removes the existing script when found", () => {
    // The guard must call existing.remove() so the old script is gone before
    // the new one is appended.
    const removeLine = SRC
      .split("\n")
      .find((l) => l.includes("existing") && l.includes(".remove()"));
    expect(removeLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Unmount cleanup — script removal
//
// React's useEffect cleanup callback runs on unmount and on every re-run
// triggered by dependency changes. The hook must remove the schema script
// in this callback so that navigating away from a schema page to a
// non-schema page never leaves a stale <script> in <head>.
// ---------------------------------------------------------------------------

describe("use-document-title — JSON-LD script removed on unmount", () => {
  it("assigns the created script element to a variable for cleanup", () => {
    expect(SRC).toContain("schemaScript =");
  });

  it("references schemaScript in the cleanup (return) callback", () => {
    // The cleanup function is the return value of the useEffect callback.
    // We verify that schemaScript appears after the 'return () =>' marker.
    const returnIdx = SRC.indexOf("return () =>");
    expect(returnIdx).toBeGreaterThanOrEqual(0);
    const cleanupSection = SRC.slice(returnIdx);
    expect(cleanupSection).toContain("schemaScript");
  });

  it("removes the script node from the DOM in the cleanup callback", () => {
    const returnIdx = SRC.indexOf("return () =>");
    expect(returnIdx).toBeGreaterThanOrEqual(0);
    const cleanupSection = SRC.slice(returnIdx);
    expect(cleanupSection).toContain("removeChild");
  });

  it("guards removeChild against a null parentNode so cleanup is safe on pages that never rendered a schema script", () => {
    // The guard `schemaScript && schemaScript.parentNode` ensures the cleanup
    // is a no-op when the hook ran without a schema option (e.g. after
    // navigating from a non-schema page to another non-schema page).
    expect(SRC).toContain("schemaScript.parentNode");
  });
});

// ---------------------------------------------------------------------------
// Dependency array
//
// The hook's useEffect must re-run whenever the schema type changes so that
// the injected JSON-LD always reflects the current page's schema.
// ---------------------------------------------------------------------------

describe("use-document-title — useEffect dependency array", () => {
  it('includes "options?.schema" in the useEffect dependency array', () => {
    const effectWithDeps = SRC.match(
      /useEffect\([\s\S]*?\[\s*[\s\S]*?options\?\.schema[\s\S]*?\]\s*\)/,
    );
    expect(effectWithDeps).toBeTruthy();
  });
});
