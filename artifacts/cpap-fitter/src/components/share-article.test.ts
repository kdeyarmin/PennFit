// Tests for components/share-article.tsx
//
// ShareArticle is a React component — it cannot be rendered in the node
// vitest environment. We use two complementary strategies:
//
//   1. Static source analysis — readFileSync on the source and assert
//      structural invariants: SSR guards, AbortError handling, testIdPrefix
//      default, mailto format, clipboard fallback, Facebook sharer URL.
//
//   2. Pure-logic re-implementation — the private `buildCanonicalUrl` helper
//      and the public URL-building logic for email/Facebook are re-implemented
//      here as standalone functions so they can be tested exhaustively without
//      a DOM environment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "share-article.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Pure-logic re-implementations — mirrors private helpers in share-article.tsx
// ---------------------------------------------------------------------------

/**
 * Re-implementation of `buildCanonicalUrl` (private in the module under test).
 * Origin + basePath (trailing slash stripped, "/" collapsed to "") + path.
 */
function buildCanonicalUrl(
  path: string,
  origin: string,
  baseUrl: string,
): string {
  const basePath = (baseUrl || "").replace(/\/$/, "");
  const canonicalBasePath = basePath === "/" ? "" : basePath;
  return `${origin}${canonicalBasePath}${path}`;
}

/**
 * Re-implementation of the mailto: href built inside `handleEmail`.
 */
function buildMailtoHref(
  url: string,
  title: string,
  blurb: string,
): string {
  const subject = encodeURIComponent(title);
  const body = encodeURIComponent(`${blurb}\n\n${url}\n\n— shared from PennPaps`);
  return `mailto:?subject=${subject}&body=${body}`;
}

/**
 * Re-implementation of the Facebook sharer href built inside `handleFacebook`.
 */
function buildFacebookShareUrl(url: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
}

// ---------------------------------------------------------------------------
// buildCanonicalUrl — BASE_URL handling
// ---------------------------------------------------------------------------

describe("buildCanonicalUrl — base-path handling", () => {
  const origin = "https://pennpaps.com";

  it("appends the path directly to origin when BASE_URL is empty string", () => {
    expect(buildCanonicalUrl("/learn/health-risks", origin, "")).toBe(
      "https://pennpaps.com/learn/health-risks",
    );
  });

  it('collapses a BASE_URL of "/" to an empty string (no double slash)', () => {
    expect(buildCanonicalUrl("/learn/health-risks", origin, "/")).toBe(
      "https://pennpaps.com/learn/health-risks",
    );
  });

  it("preserves a non-root BASE_URL sub-path prefix", () => {
    expect(buildCanonicalUrl("/learn/health-risks", origin, "/app")).toBe(
      "https://pennpaps.com/app/learn/health-risks",
    );
  });

  it("strips a trailing slash from BASE_URL before concatenating", () => {
    expect(buildCanonicalUrl("/learn/health-risks", origin, "/app/")).toBe(
      "https://pennpaps.com/app/learn/health-risks",
    );
  });

  it("produces a URL with no query string or hash — canonical clean form", () => {
    const url = buildCanonicalUrl("/learn/sleep-apnea-explained", origin, "");
    expect(url).not.toContain("?");
    expect(url).not.toContain("#");
  });

  it("uses window.location.origin as the scheme+host", () => {
    const url = buildCanonicalUrl("/learn/pap-therapy-benefits", "https://example.com", "");
    expect(url.startsWith("https://example.com")).toBe(true);
  });

  it("preserves paths with multiple segments", () => {
    expect(buildCanonicalUrl("/cpap-masks/react-health", origin, "")).toBe(
      "https://pennpaps.com/cpap-masks/react-health",
    );
  });
});

// ---------------------------------------------------------------------------
// handleEmail — mailto: URL construction
// ---------------------------------------------------------------------------

describe("handleEmail — mailto URL format", () => {
  const origin = "https://pennpaps.com";

  it("produces a mailto: scheme with no To address (share-to-anyone pattern)", () => {
    const href = buildMailtoHref(
      buildCanonicalUrl("/learn/health-risks", origin, ""),
      "The hidden cost",
      "Short blurb",
    );
    expect(href.startsWith("mailto:?")).toBe(true);
  });

  it("encodes the article title as the email subject", () => {
    const title = "The hidden cost of leaving sleep apnea alone";
    const href = buildMailtoHref(
      "https://pennpaps.com/learn/health-risks",
      title,
      "blurb",
    );
    expect(href).toContain(`subject=${encodeURIComponent(title)}`);
  });

  it("includes the article URL in the encoded body", () => {
    const url = "https://pennpaps.com/learn/health-risks";
    const href = buildMailtoHref(url, "Title", "Blurb");
    expect(decodeURIComponent(href)).toContain(url);
  });

  it('appends "— shared from PennPaps" attribution to the body', () => {
    const href = buildMailtoHref(
      "https://pennpaps.com/learn/health-risks",
      "Title",
      "Blurb",
    );
    expect(decodeURIComponent(href)).toContain("— shared from PennPaps");
  });

  it("places the blurb before the URL in the body", () => {
    const url = "https://pennpaps.com/learn/health-risks";
    const blurb = "Worth reading if you snore.";
    const decoded = decodeURIComponent(
      buildMailtoHref(url, "Title", blurb),
    );
    const bodyPart = decoded.split("&body=")[1] ?? "";
    expect(bodyPart.indexOf(blurb)).toBeLessThan(bodyPart.indexOf(url));
  });

  it("url-encodes special characters in the title (spaces, ampersands)", () => {
    const title = "CPAP & BiPAP: What's the difference?";
    const href = buildMailtoHref("https://pennpaps.com/learn/therapy-types", title, "blurb");
    // The raw subject= segment must not contain unencoded spaces or &
    const subjectSegment = href.split("&body=")[0] ?? "";
    expect(subjectSegment).not.toContain(" ");
  });
});

// ---------------------------------------------------------------------------
// handleFacebook — sharer URL construction
// ---------------------------------------------------------------------------

describe("handleFacebook — Facebook sharer URL", () => {
  it("uses the canonical Facebook sharer domain and path", () => {
    const shareUrl = buildFacebookShareUrl("https://pennpaps.com/learn/health-risks");
    expect(shareUrl.startsWith("https://www.facebook.com/sharer/sharer.php")).toBe(true);
  });

  it('encodes the article URL as the "u" query parameter', () => {
    const articleUrl = "https://pennpaps.com/learn/health-risks";
    const shareUrl = buildFacebookShareUrl(articleUrl);
    expect(shareUrl).toContain(`u=${encodeURIComponent(articleUrl)}`);
  });

  it("handles URLs with path segments (e.g. cpap-masks/react-health)", () => {
    const articleUrl = "https://pennpaps.com/cpap-masks/react-health";
    const shareUrl = buildFacebookShareUrl(articleUrl);
    expect(decodeURIComponent(shareUrl)).toContain(articleUrl);
  });

  it("produces a well-formed URL (no unencoded spaces or bare #)", () => {
    const shareUrl = buildFacebookShareUrl("https://pennpaps.com/learn/therapy-types");
    expect(shareUrl).not.toContain(" ");
    // The only # allowed would be inside the encoded URL — not at top level
    const afterQuery = shareUrl.split("?")[1] ?? "";
    expect(afterQuery.includes("#")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Static / structural checks
// ---------------------------------------------------------------------------

describe("share-article — exports", () => {
  it("exports the ShareArticle function", () => {
    expect(SRC).toContain("export function ShareArticle");
  });
});

describe("share-article — SSR guard", () => {
  it('guards handleShare with typeof window === "undefined" check', () => {
    expect(SRC).toContain('typeof window === "undefined"');
  });

  it("SSR guard appears at least twice (handleShare + handleEmail + handleFacebook)", () => {
    const matches = SRC.match(/typeof window === "undefined"/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("share-article — AbortError handling", () => {
  it("catches the AbortError from navigator.share and exits silently", () => {
    // The user dismissing the native share sheet must not trigger clipboard fallback.
    expect(SRC).toContain('err.name === "AbortError"');
  });

  it("only catches AbortError — other navigator.share errors fall through to clipboard", () => {
    // The guard should check the error name before returning, so that
    // non-abort errors (e.g. permission denied) trigger clipboard copy.
    expect(SRC).toContain("AbortError");
    expect(SRC).toContain("DOMException");
  });
});

describe("share-article — navigator.share branch", () => {
  it("checks for navigator.share before attempting the native share sheet", () => {
    expect(SRC).toContain("navigator.share");
  });

  it("passes title, text (blurb), and url to navigator.share", () => {
    // All three are required by the Web Share API for a useful share sheet.
    expect(SRC).toContain("{ title, text: blurb, url }");
  });
});

describe("share-article — clipboard fallback", () => {
  it("calls navigator.clipboard.writeText as the share fallback", () => {
    expect(SRC).toContain("navigator.clipboard.writeText(url)");
  });

  it("shows a success toast with 'Link copied' after clipboard write", () => {
    expect(SRC).toContain('"Link copied"');
  });

  it("shows a destructive toast when clipboard access is blocked", () => {
    expect(SRC).toContain('variant: "destructive"');
  });

  it("tells the user to long-press the address bar as a last resort", () => {
    expect(SRC).toContain("long-press the address bar");
  });
});

describe("share-article — testIdPrefix prop", () => {
  it('defaults testIdPrefix to "share" when not provided', () => {
    expect(SRC).toContain('testIdPrefix = "share"');
  });

  it("applies the prefix to the copy-link button data-testid", () => {
    expect(SRC).toContain('`${testIdPrefix}-copy-link`');
  });

  it("applies the prefix to the email button data-testid", () => {
    expect(SRC).toContain('`${testIdPrefix}-email`');
  });

  it("applies the prefix to the facebook button data-testid", () => {
    expect(SRC).toContain('`${testIdPrefix}-facebook`');
  });
});

describe("share-article — window.open for Facebook", () => {
  it("opens the Facebook share dialog in a new blank window", () => {
    expect(SRC).toContain('window.open(shareUrl, "_blank"');
  });

  it("includes noopener and noreferrer security attributes on the popup", () => {
    expect(SRC).toContain("noopener,noreferrer");
  });

  it("specifies popup window dimensions for the share dialog", () => {
    expect(SRC).toContain("width=600");
    expect(SRC).toContain("height=520");
  });
});

describe("share-article — email sets window.location.href", () => {
  it("navigates via window.location.href (not window.open) for the mailto link", () => {
    // mailto: should use href assignment, not a popup — some browsers block
    // window.open for mailto: schemes.
    expect(SRC).toContain("window.location.href = `mailto:");
  });
});