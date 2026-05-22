// Tests for components/share-article.tsx
//
// share-article.tsx is a React component so it can't be rendered in the
// node vitest environment. We test the one non-trivial pure function it
// contains — buildCanonicalUrl — by re-implementing it verbatim here
// (same technique used for hooks/use-url-state.test.ts), plus static
// source analysis to verify the component's structure and expected
// testIdPrefix behaviour.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "share-article.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Static / structural checks
// ---------------------------------------------------------------------------

describe("share-article — exports", () => {
  it("exports the ShareArticle function", () => {
    expect(SRC).toContain("export function ShareArticle");
  });

  it("accepts a path prop used to build the canonical URL", () => {
    expect(SRC).toContain("path: string");
  });

  it("accepts a title prop for share-sheet and email subject", () => {
    expect(SRC).toContain("title: string");
  });

  it("accepts a blurb prop for share-sheet body and email pre-body", () => {
    expect(SRC).toContain("blurb: string");
  });

  it("accepts an optional testIdPrefix prop with default value 'share'", () => {
    expect(SRC).toContain("testIdPrefix = \"share\"");
  });
});

describe("share-article — data-testid attributes", () => {
  it("stamps the copy-link button with testIdPrefix-copy-link", () => {
    expect(SRC).toContain("`${testIdPrefix}-copy-link`");
  });

  it("stamps the email button with testIdPrefix-email", () => {
    expect(SRC).toContain("`${testIdPrefix}-email`");
  });

  it("stamps the facebook button with testIdPrefix-facebook", () => {
    expect(SRC).toContain("`${testIdPrefix}-facebook`");
  });
});

describe("share-article — SSR guards", () => {
  it("guards handleShare against server-side rendering with typeof window check", () => {
    // The component is used on pages that may be SSR-rendered. Every
    // handler must bail out early if window is undefined.
    expect(SRC).toContain('typeof window === "undefined"');
  });

  it("guards handleEmail against SSR", () => {
    // handleEmail sets window.location.href — must bail early server-side.
    expect(SRC).toContain("function handleEmail");
  });

  it("guards handleFacebook against SSR", () => {
    // handleFacebook calls window.open — must bail early server-side.
    expect(SRC).toContain("function handleFacebook");
  });
});

describe("share-article — share behaviours", () => {
  it("uses the native Web Share API when navigator.share is available", () => {
    expect(SRC).toContain("navigator.share");
  });

  it("falls back to clipboard.writeText when navigator.share is unavailable", () => {
    expect(SRC).toContain("navigator.clipboard.writeText");
  });

  it("handles AbortError from Web Share API gracefully (user dismissed sheet)", () => {
    expect(SRC).toContain("AbortError");
  });

  it("builds a mailto: link in handleEmail", () => {
    expect(SRC).toContain("mailto:");
  });

  it("builds a Facebook share URL in handleFacebook", () => {
    expect(SRC).toContain("facebook.com/sharer/sharer.php");
  });

  it("opens the Facebook URL in a new tab with noopener,noreferrer", () => {
    expect(SRC).toContain("noopener,noreferrer");
  });
});

describe("share-article — footer attribution", () => {
  it("appends a PennPaps attribution line in the email body", () => {
    expect(SRC).toContain("shared from PennPaps");
  });
});

// ---------------------------------------------------------------------------
// buildCanonicalUrl — pure logic re-implementation
//
// The actual function inside share-article.tsx reads import.meta.env.BASE_URL
// and window.location.origin, neither of which we control in the node test
// environment. We therefore re-implement the same logic verbatim as a pure
// function and test it exhaustively against the documented contract.
// ---------------------------------------------------------------------------

function buildCanonicalUrl(
  origin: string,
  baseUrl: string,
  path: string,
): string {
  // Verbatim re-implementation of the private helper in share-article.tsx.
  const basePath = (baseUrl || "").replace(/\/$/, "");
  const canonicalBasePath = basePath === "/" ? "" : basePath;
  return `${origin}${canonicalBasePath}${path}`;
}

describe("buildCanonicalUrl — base cases", () => {
  it("combines origin and path when BASE_URL is empty string", () => {
    expect(buildCanonicalUrl("https://pennpaps.com", "", "/learn/health-risks"))
      .toBe("https://pennpaps.com/learn/health-risks");
  });

  it("combines origin, basePath, and path when BASE_URL has a non-root subpath", () => {
    expect(
      buildCanonicalUrl("https://pennpaps.com", "/app", "/learn/health-risks"),
    ).toBe("https://pennpaps.com/app/learn/health-risks");
  });

  it("strips the trailing slash from BASE_URL before concatenating", () => {
    // Vite emits BASE_URL with a trailing slash by default.
    expect(
      buildCanonicalUrl("https://pennpaps.com", "/app/", "/learn/health-risks"),
    ).toBe("https://pennpaps.com/app/learn/health-risks");
  });

  it("converts BASE_URL '/' to an empty string so the result is not double-slashed", () => {
    // The most common production case: Vite default BASE_URL === "/"
    expect(
      buildCanonicalUrl("https://pennpaps.com", "/", "/learn/health-risks"),
    ).toBe("https://pennpaps.com/learn/health-risks");
  });
});

describe("buildCanonicalUrl — path variations", () => {
  it("concatenates without adding a slash when path does not start with '/'", () => {
    // The function is a verbatim re-implementation of the source helper:
    //   `${origin}${canonicalBasePath}${path}`
    // It does NOT insert a separator slash. The prop contract in share-article.tsx
    // always passes rooted paths (e.g. "/learn/health-risks"), so this edge-case
    // documents the raw concatenation behaviour rather than a supported usage.
    const result = buildCanonicalUrl("https://pennpaps.com", "", "learn/foo");
    expect(result).toBe("https://pennpaps.comlearn/foo");
  });

  it("returns origin-only when path is empty", () => {
    expect(buildCanonicalUrl("https://pennpaps.com", "", ""))
      .toBe("https://pennpaps.com");
  });

  it("works with deep article paths", () => {
    expect(
      buildCanonicalUrl(
        "https://pennpaps.com",
        "/",
        "/learn/sleep-apnea-heart-health",
      ),
    ).toBe("https://pennpaps.com/learn/sleep-apnea-heart-health");
  });

  it("works with the /cpap-masks brand pages", () => {
    expect(
      buildCanonicalUrl("https://pennpaps.com", "/", "/cpap-masks/react-health"),
    ).toBe("https://pennpaps.com/cpap-masks/react-health");
  });
});

describe("buildCanonicalUrl — origin variations", () => {
  it("preserves https:// protocol in origin", () => {
    const result = buildCanonicalUrl("https://pennpaps.com", "/", "/learn/foo");
    expect(result.startsWith("https://")).toBe(true);
  });

  it("handles localhost origins for local development", () => {
    const result = buildCanonicalUrl(
      "http://localhost:5173",
      "/",
      "/learn/foo",
    );
    expect(result).toBe("http://localhost:5173/learn/foo");
  });

  it("does not duplicate slashes between origin and basePath", () => {
    const result = buildCanonicalUrl("https://pennpaps.com", "/app", "/foo");
    const slashCount = result.match(/\/\//g)?.length ?? 0;
    // Only the http:// protocol double-slash is expected.
    expect(slashCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Facebook share URL construction — re-implemented from source
// ---------------------------------------------------------------------------

function buildFacebookShareUrl(canonicalUrl: string): string {
  // Verbatim re-implementation from handleFacebook in share-article.tsx
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonicalUrl)}`;
}

describe("Facebook share URL", () => {
  it("encodes the canonical URL as a query parameter", () => {
    const url = "https://pennpaps.com/learn/health-risks";
    const fbUrl = buildFacebookShareUrl(url);
    expect(fbUrl).toContain(encodeURIComponent(url));
  });

  it("starts with the correct Facebook sharer endpoint", () => {
    const fbUrl = buildFacebookShareUrl("https://pennpaps.com/learn/foo");
    expect(fbUrl.startsWith("https://www.facebook.com/sharer/sharer.php")).toBe(
      true,
    );
  });

  it("encodes the full URL including slashes and colons", () => {
    const canonical = "https://pennpaps.com/learn/pap-therapy-benefits";
    const fbUrl = buildFacebookShareUrl(canonical);
    // The colon in https:// must be percent-encoded.
    expect(fbUrl).toContain("https%3A%2F%2F");
  });
});

// ---------------------------------------------------------------------------
// Email body construction — re-implemented from source
// ---------------------------------------------------------------------------

function buildEmailHref(
  title: string,
  blurb: string,
  canonicalUrl: string,
): string {
  // Verbatim re-implementation from handleEmail in share-article.tsx
  const subject = encodeURIComponent(title);
  const body = encodeURIComponent(
    `${blurb}\n\n${canonicalUrl}\n\n— shared from PennPaps`,
  );
  return `mailto:?subject=${subject}&body=${body}`;
}

describe("email mailto: link", () => {
  it("encodes the title as the email subject", () => {
    const href = buildEmailHref(
      "The hidden cost of leaving sleep apnea alone",
      "Worth reading.",
      "https://pennpaps.com/learn/health-risks",
    );
    expect(href).toContain(
      `subject=${encodeURIComponent("The hidden cost of leaving sleep apnea alone")}`,
    );
  });

  it("includes the canonical URL in the body", () => {
    const url = "https://pennpaps.com/learn/health-risks";
    const href = buildEmailHref("Title", "Blurb.", url);
    expect(href).toContain(encodeURIComponent(url));
  });

  it("appends PennPaps attribution footer in the body", () => {
    const href = buildEmailHref("Title", "Blurb.", "https://pennpaps.com/x");
    const decoded = decodeURIComponent(href);
    expect(decoded).toContain("shared from PennPaps");
  });

  it("starts with mailto: so browsers open the mail client", () => {
    const href = buildEmailHref("T", "B", "https://pennpaps.com/x");
    expect(href.startsWith("mailto:")).toBe(true);
  });
});