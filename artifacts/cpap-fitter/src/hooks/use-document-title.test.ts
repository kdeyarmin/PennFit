// Tests for hooks/use-document-title.tsx — PR simplification
//
// This PR removed the JSON-LD schema injection feature (options?.schema,
// SchemaType, DocumentTitleOptions) and simplified the hook to a two-argument
// signature: useDocumentTitle(pageTitle, description?).
//
// Because the vitest environment is "node" (no jsdom), we cannot render the
// hook directly. We use static source analysis — readFileSync on the hook
// source — to assert structural invariants. This mirrors the approach used by
// use-url-state.test.ts and the AppShell nav tests in this codebase.
//
// The tests in this file specifically guard the PR's simplification:
//   1. The hook no longer accepts an `options` parameter.
//   2. The JSON-LD schema injection code is completely gone.
//   3. The simplified signature and dependency array are correct.
//   4. The core OG/canonical meta-tag logic is still present.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "use-document-title.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Exports and simplified signature
// ---------------------------------------------------------------------------

describe("use-document-title — simplified signature (PR change)", () => {
  it("exports the useDocumentTitle function", () => {
    expect(SRC).toContain("export function useDocumentTitle");
  });

  it("signature accepts only pageTitle and optional description (no options)", () => {
    // The new signature must be exactly (pageTitle: string, description?: string)
    // with no third parameter.
    expect(SRC).toContain(
      "export function useDocumentTitle(pageTitle: string, description?: string)",
    );
  });

  it("does NOT accept a third options parameter", () => {
    // Guard against re-introducing the options param.
    // Check the export line specifically — the function declaration must
    // end at `description?: string)` with no additional parameter.
    const exportLine = SRC
      .split("\n")
      .find((l) => l.includes("export function useDocumentTitle"));
    expect(exportLine).toBeDefined();
    expect(exportLine).not.toContain("options");
  });
});

// ---------------------------------------------------------------------------
// JSON-LD schema injection removed
// ---------------------------------------------------------------------------

describe("use-document-title — JSON-LD schema injection removed", () => {
  it("no longer defines a SchemaType alias", () => {
    expect(SRC).not.toContain("SchemaType");
  });

  it("no longer defines a DocumentTitleOptions type", () => {
    expect(SRC).not.toContain("DocumentTitleOptions");
  });

  it("no longer references options?.schema", () => {
    expect(SRC).not.toContain("options?.schema");
  });

  it("no longer injects a JSON-LD script element", () => {
    expect(SRC).not.toContain("application/ld+json");
  });

  it("no longer uses the pf-page-schema script id", () => {
    expect(SRC).not.toContain("pf-page-schema");
  });

  it("no longer queries for an existing schema script before inserting", () => {
    expect(SRC).not.toContain('script[type="application/ld+json"]');
  });

  it("no longer defines a schemaScript variable", () => {
    // The cleanup path used `schemaScript` to remove the JSON-LD <script>.
    // With schema removed, this variable must not exist.
    expect(SRC).not.toContain("schemaScript");
  });

  it("no longer creates a script element for schema data", () => {
    expect(SRC).not.toContain("createElement(\"script\")");
  });

  it("no longer calls document.head.appendChild with a schema script", () => {
    // The source still uses appendChild for the canonical <link>, but the
    // schema-specific block that called appendChild(schemaScript) is gone.
    // We verify by checking the schemaScript variable is absent (see above)
    // and that the 'schema' keyword does not appear in the source.
    // Allow the comment in JSDoc but not in code.
    const codeLines = SRC
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    const hasSchemaCode = codeLines.some((l) => l.includes("schema"));
    expect(hasSchemaCode).toBe(false);
  });

  it("no longer includes MedicalWebPage or Article schema types", () => {
    expect(SRC).not.toContain("MedicalWebPage");
    expect(SRC).not.toContain('"Article"');
  });

  it("no longer has a JSON.stringify(schemaPayload) call", () => {
    expect(SRC).not.toContain("schemaPayload");
  });
});

// ---------------------------------------------------------------------------
// Dependency array simplified
// ---------------------------------------------------------------------------

describe("use-document-title — dependency array simplified", () => {
  it("useEffect dependency array contains pageTitle and description only", () => {
    // The simplified array must be [pageTitle, description].
    expect(SRC).toContain("[pageTitle, description]");
  });

  it("useEffect dependency array does NOT include options?.schema", () => {
    // Guard against re-introducing options?.schema as a dep.
    expect(SRC).not.toContain("options?.schema");
  });
});

// ---------------------------------------------------------------------------
// Core functionality retained after simplification
// ---------------------------------------------------------------------------

describe("use-document-title — core title + meta logic retained", () => {
  it("still imports useEffect from react", () => {
    expect(SRC).toContain('import { useEffect }');
    expect(SRC).toContain('"react"');
  });

  it("still sets document.title to fullTitle", () => {
    expect(SRC).toContain("document.title = fullTitle");
  });

  it("still restores previous title on unmount", () => {
    expect(SRC).toContain("document.title = previousTitle");
  });

  it("still sets meta description content when description is provided", () => {
    expect(SRC).toContain('metaDesc.setAttribute("content", description)');
  });

  it("still sets the canonical link element href", () => {
    expect(SRC).toContain('canonicalEl.setAttribute("href", canonicalHref)');
  });

  it("still sets og:title meta tag", () => {
    expect(SRC).toContain('meta[property="og:title"]');
  });

  it("still sets og:url meta tag", () => {
    expect(SRC).toContain('meta[property="og:url"]');
  });

  it("still sets og:description meta tag when description is provided", () => {
    expect(SRC).toContain('meta[property="og:description"]');
  });

  it("still sets twitter:title meta tag", () => {
    expect(SRC).toContain('meta[name="twitter:title"]');
  });

  it("still sets twitter:description meta tag", () => {
    expect(SRC).toContain('meta[name="twitter:description"]');
  });

  it("still uses the SITE_TITLE_SUFFIX constant for the full title", () => {
    expect(SRC).toContain("SITE_TITLE_SUFFIX");
  });

  it("still uses CANONICAL_ORIGIN for the canonical href", () => {
    expect(SRC).toContain("CANONICAL_ORIGIN");
    expect(SRC).toContain("https://pennpaps.com");
  });

  it("still strips the artifact basePath from the canonical URL", () => {
    expect(SRC).toContain("import.meta.env.BASE_URL");
  });

  it("still removes OG/Twitter tags it created on unmount", () => {
    // Cleanup iterates metaUpdates and removes created tags.
    expect(SRC).toContain("metaUpdates");
    expect(SRC).toContain("el.remove()");
  });

  it("cleanup removes the canonical link element if this hook created it", () => {
    expect(SRC).toContain("canonicalCreatedHere");
    expect(SRC).toContain("canonicalEl.remove()");
  });
});

// ---------------------------------------------------------------------------
// JSDoc comment updated
// ---------------------------------------------------------------------------

describe("use-document-title — JSDoc comment updated", () => {
  it("JSDoc no longer mentions JSON-LD or rich snippets", () => {
    expect(SRC).not.toContain("JSON-LD");
    expect(SRC).not.toContain("rich snippet");
    expect(SRC).not.toContain("rich-snippet");
  });

  it("JSDoc still explains the rationale for using a hook vs react-helmet-async", () => {
    expect(SRC).toContain("react-helmet-async");
  });
});