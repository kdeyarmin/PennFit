// Tests for pages/cpap-masks-resmed.tsx
//
// Verifies the ResMed mask data (masks array), the "why ResMed" selling
// points, exports, document title, breadcrumb, navigation targets, and
// CTA testids. Uses static source analysis — no DOM needed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "cpap-masks-resmed.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Exports & document metadata
// ---------------------------------------------------------------------------

describe("cpap-masks-resmed — exports", () => {
  it("exports the CpapMasksResmed function", () => {
    expect(SRC).toContain("export function CpapMasksResmed");
  });

  it("uses useDocumentTitle for SEO metadata", () => {
    expect(SRC).toContain("useDocumentTitle");
  });

  it("sets a document title containing 'ResMed CPAP Masks'", () => {
    expect(SRC).toContain("ResMed CPAP Masks");
  });
});

// ---------------------------------------------------------------------------
// masks array
// ---------------------------------------------------------------------------

describe("cpap-masks-resmed — masks array", () => {
  it("includes the AirFit F30i full-face mask", () => {
    expect(SRC).toContain('"AirFit F30i"');
  });

  it("includes the AirFit N30i nasal mask", () => {
    expect(SRC).toContain('"AirFit N30i"');
  });

  it("includes the AirFit P10 nasal pillow mask", () => {
    expect(SRC).toContain('"AirFit P10"');
  });

  it("lists three masks total", () => {
    const nameMatches = (SRC.match(/name:\s*"/g) ?? []).length;
    expect(nameMatches).toBe(3);
  });

  it("describes F30i as an under-the-nose full-face mask", () => {
    expect(SRC).toContain("Under-the-nose");
  });

  it("specifies F30i QuietAir vent noise level of 21 dBA", () => {
    expect(SRC).toContain("21 dBA");
  });

  it("documents P10 as the quietest CPAP mask at launch", () => {
    expect(SRC).toContain("Quietest CPAP mask ever tested at launch");
  });
});

describe("cpap-masks-resmed — mask bestFor tags", () => {
  it("marks AirFit F30i as suitable for stomach sleepers", () => {
    expect(SRC).toContain("Stomach sleepers");
  });

  it("marks AirFit F30i as suitable for claustrophobia", () => {
    expect(SRC).toContain("Claustrophobia");
  });

  it("marks AirFit P10 as suitable for travel", () => {
    expect(SRC).toContain("Travel");
  });
});

// ---------------------------------------------------------------------------
// whyResmed selling points
// ---------------------------------------------------------------------------

describe("cpap-masks-resmed — whyResmed selling points", () => {
  it("includes 'The deepest sizing matrix in the industry' point", () => {
    expect(SRC).toContain("The deepest sizing matrix in the industry");
  });

  it("includes the QuietAir diffuser vent point", () => {
    expect(SRC).toContain("QuietAir diffuser vent technology");
  });

  it("includes a worldwide clinical footprint point", () => {
    expect(SRC).toContain("Worldwide clinical footprint");
  });

  it("includes the AirTouch memory foam fallback point", () => {
    expect(SRC).toContain("AirTouch memory foam fallback");
  });

  it("includes a high-pressure reliability point", () => {
    expect(SRC).toContain("Proven through high pressures");
  });

  it("includes a 'category-defining brand' point", () => {
    expect(SRC).toContain("The category-defining brand");
  });

  it("defines six selling points total", () => {
    const titleMatches = (SRC.match(/title:\s*"/g) ?? []).length;
    expect(titleMatches).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

describe("cpap-masks-resmed — breadcrumb navigation", () => {
  it("links back to /cpap-masks for the Brands parent crumb", () => {
    expect(SRC).toContain('href="/cpap-masks"');
  });

  it("displays 'ResMed' as the current page crumb", () => {
    expect(SRC).toContain(">ResMed<");
  });
});

// ---------------------------------------------------------------------------
// Cross-brand comparison rail
// ---------------------------------------------------------------------------

describe("cpap-masks-resmed — cross-brand comparison rail", () => {
  it("links to /cpap-masks/react-health from the 'See React Health' button", () => {
    expect(SRC).toContain('href="/cpap-masks/react-health"');
  });

  it("mentions React Health in the comparison copy", () => {
    expect(SRC).toContain("React Health");
  });
});

// ---------------------------------------------------------------------------
// CTAs and navigation
// ---------------------------------------------------------------------------

describe("cpap-masks-resmed — CTAs", () => {
  it("marks the hero fitter CTA with resmed-cta-fit", () => {
    expect(SRC).toContain('"resmed-cta-fit"');
  });

  it("marks the hero shop CTA with resmed-cta-shop", () => {
    expect(SRC).toContain('"resmed-cta-shop"');
  });

  it("marks the bottom fitter CTA with resmed-bottom-cta-fit", () => {
    expect(SRC).toContain('"resmed-bottom-cta-fit"');
  });

  it("navigates to /consent when fitter CTAs are clicked", () => {
    expect(SRC).toContain('navigate("/consent")');
  });

  it("navigates to /shop when shop CTA is clicked", () => {
    expect(SRC).toContain('navigate("/shop")');
  });
});