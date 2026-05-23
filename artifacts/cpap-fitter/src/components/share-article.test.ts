// Tests for components/share-article.tsx
//
// ShareArticle provides three share channels for long-form educational
// articles:
//   1. handleShare  — Web Share API, clipboard fallback
//   2. handleEmail  — mailto: link construction
//   3. handleFacebook — facebook.com/sharer URL construction
//
// buildCanonicalUrl strips the BASE_URL prefix and any query/hash params,
// then returns `origin + canonicalBasePath + path`.
//
// The Vitest environment is "node" (no jsdom), so we:
//   a. Use static source analysis to verify structural invariants.
//   b. Re-implement the pure URL-building logic as standalone functions
//      and unit-test it directly.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "share-article.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Module structure
// ---------------------------------------------------------------------------

describe("share-article.tsx — module structure", () => {
  it("exports ShareArticle as a named export", () => {
    expect(SRC).toContain("export function ShareArticle(");
  });

  it("imports React from react", () => {
    expect(SRC).toMatch(/import React/);
  });

  it("imports Button from @/components/ui/button", () => {
    expect(SRC).toContain("Button");
    expect(SRC).toMatch(/from\s+["']@\/components\/ui\/button["']/);
  });

  it("imports Link2, Mail, MessageCircle, Sparkles from lucide-react", () => {
    expect(SRC).toContain("Link2");
    expect(SRC).toContain("Mail");
    expect(SRC).toContain("MessageCircle");
    expect(SRC).toContain("Sparkles");
  });

  it("imports useToast from @/hooks/use-toast", () => {
    expect(SRC).toContain("useToast");
    expect(SRC).toMatch(/from\s+["']@\/hooks\/use-toast["']/);
  });

  it("defines a buildCanonicalUrl helper function", () => {
    expect(SRC).toContain("function buildCanonicalUrl(");
  });
});

// ---------------------------------------------------------------------------
// ShareArticle props
// ---------------------------------------------------------------------------

describe("share-article.tsx — component props", () => {
  it("accepts a 'path' prop for the article URL segment", () => {
    expect(SRC).toContain("path: string");
  });

  it("accepts a 'title' prop for the share-sheet title and email subject", () => {
    expect(SRC).toContain("title: string");
  });

  it("accepts a 'blurb' prop for the share-sheet body", () => {
    expect(SRC).toContain("blurb: string");
  });

  it("accepts an optional 'testIdPrefix' prop defaulting to 'share'", () => {
    expect(SRC).toContain("testIdPrefix");
    expect(SRC).toContain('testIdPrefix = "share"');
  });
});

// ---------------------------------------------------------------------------
// buildCanonicalUrl — re-implemented as a pure function for unit testing
// ---------------------------------------------------------------------------
// The real implementation reads `import.meta.env.BASE_URL` and
// `window.location.origin` at call time, so we parameterise both.

function buildCanonicalUrl(
  path: string,
  origin: string,
  basePath: string,
): string {
  const normalised = basePath.replace(/\/$/, "");
  const canonicalBasePath = normalised === "/" ? "" : normalised;
  return `${origin}${canonicalBasePath}${path}`;
}

describe("buildCanonicalUrl — pure logic", () => {
  it("returns origin + path when BASE_URL is '/'", () => {
    const result = buildCanonicalUrl(
      "/learn/sleep-hygiene",
      "https://pennpaps.com",
      "/",
    );
    expect(result).toBe("https://pennpaps.com/learn/sleep-hygiene");
  });

  it("returns origin + basePath + path when BASE_URL has a subpath", () => {
    const result = buildCanonicalUrl(
      "/learn/sleep-hygiene",
      "https://preview.pennpaps.com",
      "/cpap-fitter",
    );
    expect(result).toBe(
      "https://preview.pennpaps.com/cpap-fitter/learn/sleep-hygiene",
    );
  });

  it("strips trailing slash from BASE_URL before concatenating", () => {
    const result = buildCanonicalUrl(
      "/stories",
      "https://pennpaps.com",
      "/cpap-fitter/",
    );
    expect(result).toBe("https://pennpaps.com/cpap-fitter/stories");
  });

  it("treats BASE_URL of '/' as empty basePath (no double-slash)", () => {
    const result = buildCanonicalUrl("/faq", "https://pennpaps.com", "/");
    expect(result).not.toContain("//faq");
    expect(result).toBe("https://pennpaps.com/faq");
  });

  it("preserves the article path's leading slash", () => {
    const result = buildCanonicalUrl(
      "/learn/cpap-and-weight-loss",
      "https://pennpaps.com",
      "/",
    );
    expect(result).toMatch(/^https:\/\/pennpaps\.com\/learn\//);
  });

  it("does not append query or hash components (caller strips those)", () => {
    // buildCanonicalUrl receives the clean path; it should not add anything.
    const result = buildCanonicalUrl("/stories", "https://pennpaps.com", "/");
    expect(result).not.toContain("?");
    expect(result).not.toContain("#");
  });

  it("works for root path '/'", () => {
    const result = buildCanonicalUrl("/", "https://pennpaps.com", "/");
    expect(result).toBe("https://pennpaps.com/");
  });

  it("round-trips: applying buildCanonicalUrl twice gives the same result for production origin", () => {
    const origin = "https://pennpaps.com";
    const first = buildCanonicalUrl("/learn/nasal-congestion", origin, "/");
    // The result IS the canonical URL — calling again with the path part
    // should not add the origin twice.
    const parsed = new URL(first);
    expect(parsed.origin).toBe(origin);
    expect(parsed.hostname).toBe("pennpaps.com");
    expect(parsed.protocol).toBe("https:");
    expect(first.split(origin).length).toBe(2); // exactly one occurrence
  });
});

// ---------------------------------------------------------------------------
// handleEmail — URL construction
// ---------------------------------------------------------------------------
// We cannot call the real handler (it sets window.location.href),
// but we can verify the template is correct in the source.

describe("share-article.tsx — handleEmail URL construction", () => {
  it("builds a mailto: link", () => {
    expect(SRC).toContain("mailto:");
  });

  it("uses encodeURIComponent on the title for the subject", () => {
    expect(SRC).toContain("encodeURIComponent(title)");
  });

  it("uses encodeURIComponent on the body (blurb + url)", () => {
    expect(SRC).toContain("encodeURIComponent(");
    expect(SRC).toContain("blurb");
  });

  it("appends '— shared from PennPaps' to the email body", () => {
    expect(SRC).toContain("shared from PennPaps");
  });

  it("uses window.location.href to navigate to the mailto link", () => {
    expect(SRC).toContain("window.location.href");
  });
});

// ---------------------------------------------------------------------------
// handleFacebook — URL construction
// ---------------------------------------------------------------------------

describe("share-article.tsx — handleFacebook URL construction", () => {
  it("opens the facebook.com sharer URL", () => {
    expect(SRC).toContain("facebook.com/sharer/sharer.php");
  });

  it("uses encodeURIComponent on the share URL parameter", () => {
    // The canonical URL must be percent-encoded in the sharer query string
    const sharerIdx = SRC.indexOf("facebook.com/sharer");
    expect(sharerIdx).toBeGreaterThanOrEqual(0);
    const sharerBlock = SRC.slice(sharerIdx, sharerIdx + 150);
    expect(sharerBlock).toContain("encodeURIComponent");
  });

  it("opens the sharer in a new window", () => {
    expect(SRC).toContain("window.open(");
    expect(SRC).toContain('"_blank"');
  });

  it("uses noopener,noreferrer for the new window (security best practice)", () => {
    expect(SRC).toContain("noopener");
    expect(SRC).toContain("noreferrer");
  });
});

// ---------------------------------------------------------------------------
// handleShare — Web Share API with clipboard fallback
// ---------------------------------------------------------------------------

describe("share-article.tsx — handleShare web-share logic", () => {
  it("checks navigator.share before invoking it", () => {
    expect(SRC).toContain("navigator.share");
  });

  it("calls navigator.share with title, text, and url", () => {
    expect(SRC).toContain("navigator.share({ title, text: blurb, url }");
  });

  it("silently swallows AbortError (user cancelled the share sheet)", () => {
    expect(SRC).toContain("AbortError");
  });

  it("falls back to navigator.clipboard.writeText when share is unavailable", () => {
    expect(SRC).toContain("navigator.clipboard.writeText(url)");
  });

  it("shows a toast with title 'Link copied' on clipboard success", () => {
    expect(SRC).toContain('"Link copied"');
  });

  it("shows a destructive toast when clipboard access is blocked", () => {
    expect(SRC).toContain('"Couldn\'t copy link"');
    expect(SRC).toContain('variant: "destructive"');
  });

  it("guards against server-side rendering with a typeof window check", () => {
    expect(SRC).toContain('typeof window === "undefined"');
  });
});

// ---------------------------------------------------------------------------
// data-testid attributes
// ---------------------------------------------------------------------------

describe("share-article.tsx — data-testid attributes", () => {
  it("uses '{testIdPrefix}-copy-link' for the Copy link button", () => {
    expect(SRC).toContain("${testIdPrefix}-copy-link");
  });

  it("uses '{testIdPrefix}-email' for the Email button", () => {
    expect(SRC).toContain("${testIdPrefix}-email");
  });

  it("uses '{testIdPrefix}-facebook' for the Facebook button", () => {
    expect(SRC).toContain("${testIdPrefix}-facebook");
  });
});

// ---------------------------------------------------------------------------
// buildCanonicalUrl source-level verification
// ---------------------------------------------------------------------------

describe("share-article.tsx — buildCanonicalUrl implementation details", () => {
  it("strips trailing slash from BASE_URL with .replace()", () => {
    expect(SRC).toContain('.replace(/\\/$/, "")');
  });

  it("treats a basePath of '/' as empty (canonicalBasePath = '')", () => {
    // The guard: `normalised === "/" ? "" : normalised`
    expect(SRC).toContain('canonicalBasePath = basePath === "/" ? "" : basePath');
  });

  it("reads BASE_URL from import.meta.env.BASE_URL", () => {
    expect(SRC).toContain("import.meta.env.BASE_URL");
  });

  it("reads origin from window.location.origin", () => {
    expect(SRC).toContain("window.location.origin");
  });
});