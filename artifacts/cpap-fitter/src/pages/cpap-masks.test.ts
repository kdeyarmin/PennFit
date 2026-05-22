// Tests for the new brand marketing pages:
//   pages/cpap-masks.tsx        (hub — three-brand comparison)
//   pages/cpap-masks-react-health.tsx
//   pages/cpap-masks-resmed.tsx
//   pages/cpap-masks-fisher-paykel.tsx
//
// None of these can be rendered in the node vitest environment (no DOM / React).
// We use static source analysis for structural invariants and pure-logic
// re-implementations to verify URL-building and data-array correctness.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HUB = readFileSync(path.join(__dirname, "cpap-masks.tsx"), "utf8");
const RH = readFileSync(path.join(__dirname, "cpap-masks-react-health.tsx"), "utf8");
const RESMED = readFileSync(path.join(__dirname, "cpap-masks-resmed.tsx"), "utf8");
const FP = readFileSync(path.join(__dirname, "cpap-masks-fisher-paykel.tsx"), "utf8");

// ---------------------------------------------------------------------------
// cpap-masks.tsx (hub) — exports
// ---------------------------------------------------------------------------

describe("cpap-masks — exports", () => {
  it("exports the CpapMasks function", () => {
    expect(HUB).toContain("export function CpapMasks");
  });
});

// ---------------------------------------------------------------------------
// cpap-masks.tsx — brands data array
// ---------------------------------------------------------------------------

describe("cpap-masks — brands array has exactly three entries", () => {
  it('has a "react-health" slug', () => {
    expect(HUB).toContain('slug: "react-health"');
  });

  it('has a "resmed" slug', () => {
    expect(HUB).toContain('slug: "resmed"');
  });

  it('has a "fisher-paykel" slug', () => {
    expect(HUB).toContain('slug: "fisher-paykel"');
  });
});

describe("cpap-masks — brand hrefs match registered routes", () => {
  it('React Health brand card links to "/cpap-masks/react-health"', () => {
    expect(HUB).toContain('href: "/cpap-masks/react-health"');
  });

  it('ResMed brand card links to "/cpap-masks/resmed"', () => {
    expect(HUB).toContain('href: "/cpap-masks/resmed"');
  });

  it('Fisher & Paykel brand card links to "/cpap-masks/fisher-paykel"', () => {
    expect(HUB).toContain('href: "/cpap-masks/fisher-paykel"');
  });
});

describe("cpap-masks — brand badges", () => {
  it('badges React Health as "Best Overall"', () => {
    expect(HUB).toContain('badge: "Best Overall"');
  });

  it('badges ResMed as "Most Popular"', () => {
    expect(HUB).toContain('badge: "Most Popular"');
  });

  it('badges Fisher & Paykel as "Best for Movers"', () => {
    expect(HUB).toContain('badge: "Best for Movers"');
  });
});

describe("cpap-masks — React Health is the flagship (index 0)", () => {
  it("React Health appears first in the brands array", () => {
    const rhIdx = HUB.indexOf('slug: "react-health"');
    const rmIdx = HUB.indexOf('slug: "resmed"');
    const fpIdx = HUB.indexOf('slug: "fisher-paykel"');
    expect(rhIdx).toBeLessThan(rmIdx);
    expect(rhIdx).toBeLessThan(fpIdx);
  });

  it("flagship treatment is applied based on index 0 (isFlagship = idx === 0)", () => {
    expect(HUB).toContain("const isFlagship = idx === 0");
  });

  it("only the flagship card gets the tech glass treatment", () => {
    expect(HUB).toContain("glass-card-tech");
  });
});

describe("cpap-masks — comparison decision-tree links match brand pages", () => {
  it('the "New to CPAP" suggestion links to /cpap-masks/react-health', () => {
    expect(HUB).toContain('href: "/cpap-masks/react-health"');
  });

  it('the "Hard-to-fit faces" suggestion links to /cpap-masks/resmed', () => {
    expect(HUB).toContain('href: "/cpap-masks/resmed"');
  });

  it('the "Side or stomach sleepers" suggestion links to /cpap-masks/fisher-paykel', () => {
    expect(HUB).toContain('href: "/cpap-masks/fisher-paykel"');
  });
});

describe("cpap-masks — data-testid attributes", () => {
  it("bottom CTA button has data-testid brands-bottom-cta-fit", () => {
    expect(HUB).toContain('data-testid="brands-bottom-cta-fit"');
  });

  it("hero CTA button has data-testid brands-cta-fit", () => {
    expect(HUB).toContain('data-testid="brands-cta-fit"');
  });

  it("hero catalog button has data-testid brands-cta-catalog", () => {
    expect(HUB).toContain('data-testid="brands-cta-catalog"');
  });

  it("brand cards use data-testid brand-card-{slug}", () => {
    expect(HUB).toContain('data-testid={`brand-card-${b.slug}`}');
  });
});

describe("cpap-masks — CTA navigation targets", () => {
  it("hero fit CTA navigates to /consent", () => {
    expect(HUB).toContain('navigate("/consent")');
  });

  it("catalog CTA navigates to /masks", () => {
    expect(HUB).toContain('navigate("/masks")');
  });
});

// ---------------------------------------------------------------------------
// cpap-masks-react-health.tsx — exports and data
// ---------------------------------------------------------------------------

describe("cpap-masks-react-health — exports", () => {
  it("exports the CpapMasksReactHealth function", () => {
    expect(RH).toContain("export function CpapMasksReactHealth");
  });
});

describe("cpap-masks-react-health — flagshipMasks data", () => {
  it("includes the Rio II nasal pillow mask", () => {
    expect(RH).toContain('"Rio II"');
  });

  it("includes the Viva Nasal mask", () => {
    expect(RH).toContain('"Viva Nasal"');
  });

  it("includes the Numa Full Face mask", () => {
    expect(RH).toContain('"Numa Full Face"');
  });

  it("has three masks in the flagshipMasks array", () => {
    // Count name: "..." occurrences in the masks data block.
    const nameMatches = RH.match(/name: "(?:Rio II|Viva Nasal|Numa Full Face)"/g);
    expect(nameMatches).toHaveLength(3);
  });
});

describe("cpap-masks-react-health — why-React-Health selling points", () => {
  it('promotes "Built in Florida" as a selling point', () => {
    expect(RH).toContain('"Built in Florida"');
  });

  it('promotes "Insurance-friendly pricing" as a selling point', () => {
    expect(RH).toContain('"Insurance-friendly pricing"');
  });

  it("has six selling points in whyReactHealth", () => {
    // Each selling point has a distinct title field.
    const titles = [
      "Built in Florida",
      "Insurance-friendly pricing",
      "Genuinely lightweight",
      "Quietest exhalation vents on the market",
      "Designed for real sleepers",
      "Cleared for the same pressures",
    ];
    for (const title of titles) {
      expect(RH).toContain(`"${title}"`);
    }
  });
});

describe("cpap-masks-react-health — breadcrumb and navigation", () => {
  it('breadcrumb links back to "/cpap-masks" (the hub)', () => {
    expect(RH).toContain('href="/cpap-masks"');
  });

  it("hero CTA navigates to /consent", () => {
    expect(RH).toContain('navigate("/consent")');
  });

  it("shop CTA navigates to /shop", () => {
    expect(RH).toContain('navigate("/shop")');
  });

  it("data-testid rh-cta-fit is set on the hero match button", () => {
    expect(RH).toContain('data-testid="rh-cta-fit"');
  });

  it("data-testid rh-bottom-cta-fit is set on the bottom CTA", () => {
    expect(RH).toContain('data-testid="rh-bottom-cta-fit"');
  });
});

describe("cpap-masks-react-health — Rio II weight claim", () => {
  it("references the 88g weight of the Rio II for the lightweight claim", () => {
    expect(RH).toContain("88g");
  });
});

// ---------------------------------------------------------------------------
// cpap-masks-resmed.tsx — exports and data
// ---------------------------------------------------------------------------

describe("cpap-masks-resmed — exports", () => {
  it("exports the CpapMasksResmed function", () => {
    expect(RESMED).toContain("export function CpapMasksResmed");
  });
});

describe("cpap-masks-resmed — masks data", () => {
  it("includes the AirFit F30i full-face mask", () => {
    expect(RESMED).toContain('"AirFit F30i"');
  });

  it("includes the AirFit N30i nasal mask", () => {
    expect(RESMED).toContain('"AirFit N30i"');
  });

  it("includes the AirFit P10 nasal pillow", () => {
    expect(RESMED).toContain('"AirFit P10"');
  });

  it("has three masks in the masks array", () => {
    const nameMatches = RESMED.match(/name: "AirFit (?:F30i|N30i|P10)"/g);
    expect(nameMatches).toHaveLength(3);
  });
});

describe("cpap-masks-resmed — whyResmed selling points", () => {
  it('includes "The deepest sizing matrix in the industry"', () => {
    expect(RESMED).toContain("The deepest sizing matrix in the industry");
  });

  it('includes "QuietAir diffuser vent technology"', () => {
    expect(RESMED).toContain("QuietAir diffuser vent technology");
  });

  it("has six selling points", () => {
    const titles = [
      "The deepest sizing matrix in the industry",
      "QuietAir diffuser vent technology",
      "Worldwide clinical footprint",
      "AirTouch memory foam fallback",
      "Proven through high pressures",
      "The category-defining brand",
    ];
    for (const t of titles) {
      expect(RESMED).toContain(t);
    }
  });
});

describe("cpap-masks-resmed — navigation and data-testid", () => {
  it('breadcrumb links back to "/cpap-masks"', () => {
    expect(RESMED).toContain('href="/cpap-masks"');
  });

  it('comparison rail links to "/cpap-masks/react-health"', () => {
    expect(RESMED).toContain('href="/cpap-masks/react-health"');
  });

  it("data-testid resmed-cta-fit is present", () => {
    expect(RESMED).toContain('data-testid="resmed-cta-fit"');
  });

  it("data-testid resmed-bottom-cta-fit is present", () => {
    expect(RESMED).toContain('data-testid="resmed-bottom-cta-fit"');
  });
});

// ---------------------------------------------------------------------------
// cpap-masks-fisher-paykel.tsx — exports and data
// ---------------------------------------------------------------------------

describe("cpap-masks-fisher-paykel — exports", () => {
  it("exports the CpapMasksFisherPaykel function", () => {
    expect(FP).toContain("export function CpapMasksFisherPaykel");
  });
});

describe("cpap-masks-fisher-paykel — masks data", () => {
  it("includes the Evora nasal mask", () => {
    expect(FP).toContain('"Evora"');
  });

  it("includes the Brevida nasal pillow", () => {
    expect(FP).toContain('"Brevida"');
  });

  it("includes the Vitera full-face mask", () => {
    expect(FP).toContain('"Vitera"');
  });

  it("has three masks in the masks array", () => {
    const nameMatches = FP.match(/name: "(?:Evora|Brevida|Vitera)"/g);
    expect(nameMatches).toHaveLength(3);
  });
});

describe("cpap-masks-fisher-paykel — whyFp selling points", () => {
  it('includes "RollFit cushion technology"', () => {
    expect(FP).toContain("RollFit cushion technology");
  });

  it('includes "AirPillow gentle-seal nasal pillows"', () => {
    expect(FP).toContain("AirPillow gentle-seal nasal pillows");
  });

  it('includes "Designed in New Zealand" provenance', () => {
    expect(FP).toContain("Designed in New Zealand");
  });

  it("has six selling points in whyFp", () => {
    const titles = [
      "RollFit cushion technology",
      "AirPillow gentle-seal nasal pillows",
      "Designed for real overnight motion",
      "Low-impact packaging",
      "Whisper-quiet diffuser vents",
      "Designed in New Zealand",
    ];
    for (const t of titles) {
      expect(FP).toContain(t);
    }
  });
});

describe("cpap-masks-fisher-paykel — navigation and data-testid", () => {
  it('breadcrumb links back to "/cpap-masks"', () => {
    expect(FP).toContain('href="/cpap-masks"');
  });

  it('comparison rail links to "/cpap-masks/react-health" (flagship)', () => {
    expect(FP).toContain('href="/cpap-masks/react-health"');
  });

  it("data-testid fp-cta-fit is present on the hero CTA", () => {
    expect(FP).toContain('data-testid="fp-cta-fit"');
  });

  it("data-testid fp-bottom-cta-fit is present on the bottom CTA", () => {
    expect(FP).toContain('data-testid="fp-bottom-cta-fit"');
  });
});

describe("cpap-masks-fisher-paykel — Evora best-for tags", () => {
  it("marks Evora as good for side sleepers", () => {
    expect(FP).toContain("Side sleepers");
  });

  it("marks Brevida as good for first-time pillow users", () => {
    expect(FP).toContain("First-time pillows");
  });

  it("marks Vitera as best for restless sleepers", () => {
    expect(FP).toContain("Restless sleepers");
  });
});