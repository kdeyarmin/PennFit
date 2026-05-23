// Tests for pages/cpap-masks-fisher-paykel.tsx
//
// Verifies the Fisher & Paykel mask data (masks array), the "why F&P"
// selling points, exports, document title, breadcrumb, navigation targets,
// and CTA testids. Uses static source analysis — no DOM needed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "cpap-masks-fisher-paykel.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Exports & document metadata
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — exports", () => {
  it("exports the CpapMasksFisherPaykel function", () => {
    expect(SRC).toContain("export function CpapMasksFisherPaykel");
  });

  it("uses useDocumentTitle for SEO metadata", () => {
    expect(SRC).toContain("useDocumentTitle");
  });

  it("sets a document title containing 'Fisher & Paykel CPAP Masks'", () => {
    expect(SRC).toContain("Fisher & Paykel CPAP Masks");
  });
});

// ---------------------------------------------------------------------------
// masks array
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — masks array", () => {
  it("includes the Evora nasal mask", () => {
    expect(SRC).toContain('"Evora"');
  });

  it("includes the Brevida nasal pillow mask", () => {
    expect(SRC).toContain('"Brevida"');
  });

  it("includes the Vitera full-face mask", () => {
    expect(SRC).toContain('"Vitera"');
  });

  it("lists three masks total", () => {
    const nameMatches = (SRC.match(/name:\s*"/g) ?? []).length;
    expect(nameMatches).toBe(3);
  });

  it("describes Evora as using CapFit headgear", () => {
    expect(SRC).toContain("CapFit headgear");
  });

  it("describes Brevida as having the AirPillow cushion", () => {
    expect(SRC).toContain("AirPillow");
  });

  it("describes Vitera as using RollFit XT cushion", () => {
    expect(SRC).toContain("RollFit XT cushion");
  });
});

describe("cpap-masks-fisher-paykel — mask bestFor tags", () => {
  it("marks Evora as suitable for side sleepers", () => {
    expect(SRC).toContain("Side sleepers");
  });

  it("marks Evora as suitable for anti-claustrophobia", () => {
    expect(SRC).toContain("Anti-claustrophobia");
  });

  it("marks Brevida as suitable for sensitive skin", () => {
    expect(SRC).toContain("Sensitive skin");
  });

  it("marks Brevida as suitable for first-time pillow users", () => {
    expect(SRC).toContain("First-time pillows");
  });

  it("marks Vitera as suitable for restless sleepers", () => {
    expect(SRC).toContain("Restless sleepers");
  });

  it("marks Vitera as suitable for larger faces", () => {
    expect(SRC).toContain("Larger faces");
  });
});

// ---------------------------------------------------------------------------
// whyFp selling points
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — whyFp selling points", () => {
  it("includes a RollFit cushion technology point", () => {
    expect(SRC).toContain("RollFit cushion technology");
  });

  it("includes an AirPillow gentle-seal nasal pillows point", () => {
    expect(SRC).toContain("AirPillow gentle-seal nasal pillows");
  });

  it("includes a point about design for overnight motion", () => {
    expect(SRC).toContain("Designed for real overnight motion");
  });

  it("includes a low-impact packaging point", () => {
    expect(SRC).toContain("Low-impact packaging");
  });

  it("includes a whisper-quiet diffuser vents point", () => {
    expect(SRC).toContain("Whisper-quiet diffuser vents");
  });

  it("includes a 'Designed in New Zealand' point", () => {
    expect(SRC).toContain("Designed in New Zealand");
  });

  it("defines six selling points total", () => {
    const titleMatches = (SRC.match(/title:\s*"/g) ?? []).length;
    expect(titleMatches).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — breadcrumb navigation", () => {
  it("links back to /cpap-masks for the Brands parent crumb", () => {
    expect(SRC).toContain('href="/cpap-masks"');
  });

  it("displays 'Fisher & Paykel' as the current page crumb text", () => {
    // The HTML entity form is used for the breadcrumb text.
    expect(SRC).toContain("Fisher");
    expect(SRC).toContain("Paykel");
  });
});

// ---------------------------------------------------------------------------
// Cross-brand comparison rail
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — cross-brand comparison rail", () => {
  it("links to /cpap-masks/react-health from the 'See React Health' button", () => {
    expect(SRC).toContain('href="/cpap-masks/react-health"');
  });

  it("recommends React Health as the flagship for most new users", () => {
    expect(SRC).toContain("React Health is our top recommendation for most new users");
  });
});

// ---------------------------------------------------------------------------
// CTAs and navigation
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — CTAs", () => {
  it("marks the hero fitter CTA with fp-cta-fit", () => {
    expect(SRC).toContain('"fp-cta-fit"');
  });

  it("marks the hero shop CTA with fp-cta-shop", () => {
    expect(SRC).toContain('"fp-cta-shop"');
  });

  it("marks the bottom fitter CTA with fp-bottom-cta-fit", () => {
    expect(SRC).toContain('"fp-bottom-cta-fit"');
  });

  it("navigates to /consent when fitter CTAs are clicked", () => {
    expect(SRC).toContain('navigate("/consent")');
  });

  it("navigates to /shop when shop CTA is clicked", () => {
    expect(SRC).toContain('navigate("/shop")');
  });
});

// ---------------------------------------------------------------------------
// Brand origin claim
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — brand origin", () => {
  it("mentions Auckland as F&P's design base", () => {
    expect(SRC).toContain("Auckland");
  });

  it("references F&P's founding year (1971)", () => {
    expect(SRC).toContain("1971");
  });
});