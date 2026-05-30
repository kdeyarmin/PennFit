// Tests for pages/cpap-masks-react-health.tsx
//
// Verifies the flagship mask data (flagshipMasks array), the "why React
// Health" selling points (whyReactHealth array), and the page's exports,
// document title, navigation targets, and CTA testids.
// Uses static source analysis — no DOM or React rendering needed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "cpap-masks-react-health.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Exports & document metadata
// ---------------------------------------------------------------------------

describe("cpap-masks-react-health — exports", () => {
  it("exports the CpapMasksReactHealth function", () => {
    expect(SRC).toContain("export function CpapMasksReactHealth");
  });

  it("uses useDocumentTitle for SEO metadata", () => {
    expect(SRC).toContain("useDocumentTitle");
  });

  it("sets a document title containing 'React Health CPAP Masks'", () => {
    expect(SRC).toContain("React Health CPAP Masks");
  });
});

// ---------------------------------------------------------------------------
// flagshipMasks array
// ---------------------------------------------------------------------------

describe("cpap-masks-react-health — flagshipMasks array", () => {
  it("includes the Rio II nasal pillow mask", () => {
    expect(SRC).toContain('"Rio II"');
  });

  it("includes the Viva Nasal mask", () => {
    expect(SRC).toContain('"Viva Nasal"');
  });

  it("includes the Numa Full Face mask", () => {
    expect(SRC).toContain('"Numa Full Face"');
  });

  it("lists three flagship masks total", () => {
    // Count name: entries to validate count — each mask has exactly one name.
    const nameMatches = (SRC.match(/name:\s*"/g) ?? []).length;
    expect(nameMatches).toBe(3);
  });

  it("calls out Rio II as '88g' — its defining weight spec", () => {
    expect(SRC).toContain("88g");
  });

  it("documents that Rio II includes three pillow sizes in every box", () => {
    expect(SRC).toContain("Three nasal pillow sizes ship in every box");
  });

  it("documents that Viva Nasal seals up to 25 cmH₂O", () => {
    expect(SRC).toContain("25 cmH₂O");
  });

  it("documents that Numa Full Face has a quick-release elbow", () => {
    expect(SRC).toContain("Quick-release elbow");
  });
});

describe("cpap-masks-react-health — flagshipMasks bestFor tags", () => {
  it("marks Rio II as suitable for first-time users", () => {
    expect(SRC).toContain("First-time users");
  });

  it("marks Viva Nasal as suitable for higher pressures", () => {
    expect(SRC).toContain("Higher pressures");
  });

  it("marks Numa Full Face as suitable for mouth breathers", () => {
    expect(SRC).toContain("Mouth breathers");
  });

  it("marks Numa Full Face as suitable for BiPAP", () => {
    expect(SRC).toContain("BiPAP");
  });
});

// ---------------------------------------------------------------------------
// whyReactHealth selling points
// ---------------------------------------------------------------------------

describe("cpap-masks-react-health — whyReactHealth selling points", () => {
  it("includes 'Built in Florida' point", () => {
    expect(SRC).toContain("Built in Florida");
  });

  it("includes 'Insurance-friendly pricing' point", () => {
    expect(SRC).toContain("Insurance-friendly pricing");
  });

  it("includes 'Genuinely lightweight' point", () => {
    expect(SRC).toContain("Genuinely lightweight");
  });

  it("includes 'Quietest exhalation vents on the market' point", () => {
    expect(SRC).toContain("Quietest exhalation vents on the market");
  });

  it("includes 'Designed for real sleepers' point", () => {
    expect(SRC).toContain("Designed for real sleepers");
  });

  it("includes a point about FDA clearance for the same pressure range", () => {
    expect(SRC).toContain("Cleared for the same pressures");
  });

  it("defines six selling points total", () => {
    const titleMatches = (SRC.match(/title:\s*"/g) ?? []).length;
    expect(titleMatches).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

describe("cpap-masks-react-health — breadcrumb navigation", () => {
  it("links back to /cpap-masks for the Brands parent crumb", () => {
    expect(SRC).toContain('href="/cpap-masks"');
  });

  it("displays 'React Health' as the current page crumb", () => {
    expect(SRC).toContain(">React Health<");
  });
});

// ---------------------------------------------------------------------------
// CTAs and navigation
// ---------------------------------------------------------------------------

describe("cpap-masks-react-health — CTAs", () => {
  it("marks the hero fitter CTA with rh-cta-fit", () => {
    expect(SRC).toContain('"rh-cta-fit"');
  });

  it("marks the hero shop CTA with rh-cta-shop", () => {
    expect(SRC).toContain('"rh-cta-shop"');
  });

  it("marks the bottom fitter CTA with rh-bottom-cta-fit", () => {
    expect(SRC).toContain('"rh-bottom-cta-fit"');
  });

  it("marks the bottom shop CTA with rh-bottom-cta-shop", () => {
    expect(SRC).toContain('"rh-bottom-cta-shop"');
  });

  it("navigates to /consent when fitter CTAs are clicked", () => {
    expect(SRC).toContain('navigate("/consent")');
  });

  it("navigates to /shop when shop CTAs are clicked", () => {
    expect(SRC).toContain('navigate("/shop")');
  });
});

// ---------------------------------------------------------------------------
// Social proof
// ---------------------------------------------------------------------------

describe("cpap-masks-react-health — social proof", () => {
  it("includes a patient quote referencing the Rio II", () => {
    expect(SRC).toContain("Rio II");
    // The quote also references PennPaps as the provider.
    expect(SRC).toContain("PennPaps patient");
  });
});
