// Tests for use-document-title.tsx
//
// The vitest environment is "node" (no DOM) so we:
//   1. Read the source file as a string to assert structural invariants
//      (constants, hook export, cleanup pattern).
//   2. Re-implement the pure canonical-URL computation logic and drive it
//      with various base-path and pathname inputs to verify the stripping
//      and slash-normalisation rules that are documented in the hook.
//
// DOM interactions (document.title, meta tag manipulation) are NOT covered
// here because they require jsdom; the static guards below ensure those
// code paths are at least present in the source.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "use-document-title.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// SECTION 1 — Static source guards
// ---------------------------------------------------------------------------

describe("use-document-title — SITE_TITLE_SUFFIX constant", () => {
  it("defines SITE_TITLE_SUFFIX", () => {
    expect(SRC).toContain("SITE_TITLE_SUFFIX");
  });

  it("SITE_TITLE_SUFFIX includes the PennPaps brand name", () => {
    expect(SRC).toContain("PennPaps");
  });

  it("SITE_TITLE_SUFFIX uses an em-dash separator", () => {
    expect(SRC).toContain(" — PennPaps");
  });

  it("SITE_TITLE_SUFFIX includes the full practice name", () => {
    expect(SRC).toContain("Penn Home Medical Supply");
  });
});

describe("use-document-title — CANONICAL_ORIGIN constant", () => {
  it("defines CANONICAL_ORIGIN", () => {
    expect(SRC).toContain("CANONICAL_ORIGIN");
  });

  it("hardcodes the production origin (not window.location.origin)", () => {
    expect(SRC).toContain('"https://pennpaps.com"');
    expect(SRC).not.toContain("window.location.origin");
  });

  it("does not include a trailing slash in CANONICAL_ORIGIN", () => {
    // A trailing slash would produce double-slashes in canonical URLs.
    expect(SRC).not.toContain('"https://pennpaps.com/"');
  });
});

describe("use-document-title — hook export and signature", () => {
  it("exports useDocumentTitle as a named export", () => {
    expect(SRC).toContain("export function useDocumentTitle(");
  });

  it("accepts pageTitle as the first argument", () => {
    expect(SRC).toContain("pageTitle: string");
  });

  it("accepts description as an optional second argument", () => {
    expect(SRC).toContain("description?:");
  });

  it("uses useEffect from react", () => {
    expect(SRC).toContain("useEffect");
  });
});

describe("use-document-title — title building logic", () => {
  it("builds full title by appending SITE_TITLE_SUFFIX to pageTitle", () => {
    expect(SRC).toContain("`${pageTitle}${SITE_TITLE_SUFFIX}`");
  });

  it("uses previous title as fallback when pageTitle is empty", () => {
    // Empty pageTitle should not change the document title — the ternary
    // falls through to `previousTitle` so the tab title is unchanged.
    expect(SRC).toContain(": previousTitle");
    // The ternary produces the full title when pageTitle is truthy.
    expect(SRC).toContain("? `${pageTitle}${SITE_TITLE_SUFFIX}`");
  });
});

describe("use-document-title — canonical URL computation", () => {
  it("reads BASE_URL from import.meta.env to find the artifact basePath", () => {
    expect(SRC).toContain("import.meta.env.BASE_URL");
  });

  it("strips a trailing slash from basePath before the startsWith check", () => {
    expect(SRC).toContain('.replace(/\\/$/, "")');
  });

  it("strips the basePath prefix from the current pathname", () => {
    expect(SRC).toContain("rawPath.startsWith(basePath)");
    expect(SRC).toContain("rawPath.slice(basePath.length)");
  });

  it("falls back to '/' when slicing basePath leaves an empty string", () => {
    // e.g. basePath='/cpap-fitter', rawPath='/cpap-fitter' → '' → '/'
    expect(SRC).toContain('|| "/"');
  });

  it("strips trailing slashes from paths longer than '/'", () => {
    expect(SRC).toContain('.replace(/\\/+$/, "")');
  });

  it("builds the canonical href by prepending CANONICAL_ORIGIN", () => {
    expect(SRC).toContain("`${CANONICAL_ORIGIN}${canonicalPath}`");
  });
});

describe("use-document-title — canonical link element management", () => {
  it("queries for an existing link[rel='canonical'] element", () => {
    expect(SRC).toContain('link[rel="canonical"]');
  });

  it("creates a canonical link element when one doesn't exist", () => {
    expect(SRC).toContain('canonicalEl.setAttribute("rel", "canonical")');
  });

  it("tracks whether the canonical element was created by this hook", () => {
    expect(SRC).toContain("canonicalCreatedHere");
  });

  it("removes the created canonical element on cleanup", () => {
    expect(SRC).toContain("canonicalEl.remove()");
  });

  it("restores the previous canonical href on cleanup when element pre-existed", () => {
    expect(SRC).toContain("previousCanonicalHref");
  });
});

describe("use-document-title — OpenGraph meta tags", () => {
  it("sets og:title when pageTitle is provided", () => {
    expect(SRC).toContain('meta[property="og:title"]');
  });

  it("sets og:description when description is provided", () => {
    expect(SRC).toContain('meta[property="og:description"]');
  });

  it("sets og:url on every route", () => {
    expect(SRC).toContain('meta[property="og:url"]');
  });

  it("sets og:type on every route", () => {
    expect(SRC).toContain('meta[property="og:type"]');
    expect(SRC).toContain('"website"');
  });

  it("sets twitter:title when pageTitle is provided", () => {
    expect(SRC).toContain('meta[name="twitter:title"]');
  });

  it("sets twitter:description when description is provided", () => {
    expect(SRC).toContain('meta[name="twitter:description"]');
  });
});

describe("use-document-title — meta tag lifecycle (getOrCreateMeta helper)", () => {
  it("defines getOrCreateMeta helper", () => {
    expect(SRC).toContain("function getOrCreateMeta(");
  });

  it("getOrCreateMeta returns both the element and a 'created' boolean", () => {
    expect(SRC).toContain("el: HTMLMetaElement");
    expect(SRC).toContain("created: boolean");
  });

  it("getOrCreateMeta only creates an element if none is found by the selector", () => {
    expect(SRC).toContain(
      "document.head.querySelector<HTMLMetaElement>(selector)",
    );
  });

  it("tracks metaUpdates array for cleanup", () => {
    expect(SRC).toContain("metaUpdates");
  });

  it("removes created meta tags on cleanup", () => {
    // For each tag we added from scratch, el.remove() is called in cleanup.
    expect(SRC).toContain("el.remove()");
  });

  it("restores previous meta content on cleanup for pre-existing tags", () => {
    expect(SRC).toContain("el.setAttribute(attr, previous)");
  });
});

describe("use-document-title — title and description cleanup", () => {
  it("restores document.title to previousTitle on cleanup", () => {
    expect(SRC).toContain("document.title = previousTitle");
  });

  it("reads previousTitle before any modification", () => {
    expect(SRC).toContain("const previousTitle = document.title");
  });

  it("restores the meta description on cleanup when it was modified", () => {
    expect(SRC).toContain('meta[name="description"]');
    expect(SRC).toContain("previousDesc");
  });
});

// ---------------------------------------------------------------------------
// SECTION 2 — Pure canonical-path computation re-implemented for unit tests
// ---------------------------------------------------------------------------
// The canonical URL logic inside useDocumentTitle is re-implemented here
// as a standalone pure function so we can exercise its path-stripping and
// slash-normalisation rules without needing a DOM or live import.meta.env.

const CANONICAL_ORIGIN = "https://pennpaps.com";

/**
 * Mirrors the canonical path computation in use-document-title.tsx:
 *   1. Strip the artifact basePath (e.g. "/cpap-fitter") from rawPath.
 *   2. Normalise: "" → "/", strip trailing slashes from longer paths.
 *   3. Prepend CANONICAL_ORIGIN.
 */
function buildCanonicalHref(basePath: string, rawPath: string): string {
  const base = basePath.replace(/\/$/, ""); // strip trailing slash
  const trimmedPath =
    base && rawPath.startsWith(base)
      ? rawPath.slice(base.length) || "/"
      : rawPath;
  const canonicalPath =
    trimmedPath.length > 1 ? trimmedPath.replace(/\/+$/, "") : "/";
  return `${CANONICAL_ORIGIN}${canonicalPath}`;
}

describe("canonical path computation — basePath stripping", () => {
  it("strips the basePath prefix when the pathname starts with it", () => {
    expect(
      buildCanonicalHref("/cpap-fitter", "/cpap-fitter/learn/cpap-masks"),
    ).toBe("https://pennpaps.com/learn/cpap-masks");
  });

  it("does NOT strip when the pathname does not start with basePath", () => {
    expect(buildCanonicalHref("/cpap-fitter", "/other/page")).toBe(
      "https://pennpaps.com/other/page",
    );
  });

  it("returns the root URL when basePath equals rawPath (e.g. root landing page)", () => {
    expect(buildCanonicalHref("/cpap-fitter", "/cpap-fitter")).toBe(
      "https://pennpaps.com/",
    );
  });

  it("works when basePath is empty (production deploy at root)", () => {
    expect(buildCanonicalHref("", "/learn/cpap-masks")).toBe(
      "https://pennpaps.com/learn/cpap-masks",
    );
  });

  it("handles a basePath with a trailing slash correctly", () => {
    // The hook strips the trailing slash from BASE_URL before the check.
    expect(buildCanonicalHref("/cpap-fitter/", "/cpap-fitter/shop")).toBe(
      "https://pennpaps.com/shop",
    );
  });
});

describe("canonical path computation — trailing slash normalisation", () => {
  it("strips a trailing slash from non-root paths", () => {
    expect(buildCanonicalHref("", "/shop/")).toBe("https://pennpaps.com/shop");
  });

  it("strips multiple consecutive trailing slashes", () => {
    expect(buildCanonicalHref("", "/shop///")).toBe(
      "https://pennpaps.com/shop",
    );
  });

  it("preserves the root '/' — does not produce an empty pathname", () => {
    expect(buildCanonicalHref("", "/")).toBe("https://pennpaps.com/");
  });

  it("does not strip the leading slash from the path", () => {
    const href = buildCanonicalHref("", "/learn/cpap-masks");
    expect(href).toMatch(/^https:\/\/pennpaps\.com\//);
  });

  it("always produces a URL starting with CANONICAL_ORIGIN", () => {
    for (const raw of ["/", "/shop", "/shop/", "/learn/sleep-apnea"]) {
      expect(buildCanonicalHref("", raw)).toMatch(/^https:\/\/pennpaps\.com/);
    }
  });
});

describe("canonical path computation — edge cases", () => {
  it("handles a deeply nested path without mangling intermediate slashes", () => {
    expect(
      buildCanonicalHref("/cpap-fitter", "/cpap-fitter/admin/billing/ai-queue"),
    ).toBe("https://pennpaps.com/admin/billing/ai-queue");
  });

  it("handles a path that is exactly the basePath plus trailing slash", () => {
    // e.g. user navigates to "/cpap-fitter/" → trimmed to "" → falls back to "/"
    expect(buildCanonicalHref("/cpap-fitter", "/cpap-fitter/")).toBe(
      "https://pennpaps.com/",
    );
  });
});
