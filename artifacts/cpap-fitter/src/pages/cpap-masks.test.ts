// Tests for pages/cpap-masks.tsx — brands hub page data integrity
//
// The CpapMasks page renders a card for each brand in the `brands` array.
// Because the node vitest environment has no DOM, we test the source
// statically (readFileSync) and extract the structured data via regex
// rather than rendering. This catches regressions like a missing href,
// a wrong badge label, or a brand being accidentally removed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "cpap-masks.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

describe("cpap-masks — exports", () => {
  it("exports the CpapMasks function", () => {
    expect(SRC).toContain("export function CpapMasks");
  });

  it("uses useDocumentTitle for SEO metadata", () => {
    expect(SRC).toContain("useDocumentTitle");
  });

  it("calls useDocumentTitle with a title containing 'CPAP Mask Brands'", () => {
    expect(SRC).toContain("CPAP Mask Brands");
  });
});

describe("cpap-masks — brands array completeness", () => {
  it("defines three brand entries (react-health, resmed, fisher-paykel)", () => {
    const slugMatches = SRC.match(/slug:\s*"([^"]+)"/g) ?? [];
    const slugs = slugMatches.map((m) =>
      m.replace(/^slug:\s*"/, "").replace(/"$/, ""),
    );
    expect(slugs).toContain("react-health");
    expect(slugs).toContain("resmed");
    expect(slugs).toContain("fisher-paykel");
    expect(slugs.length).toBe(3);
  });

  it("defines href /cpap-masks/react-health for the React Health brand", () => {
    expect(SRC).toContain('href: "/cpap-masks/react-health"');
  });

  it("defines href /cpap-masks/resmed for the ResMed brand", () => {
    expect(SRC).toContain('href: "/cpap-masks/resmed"');
  });

  it("defines href /cpap-masks/fisher-paykel for the F&P brand", () => {
    expect(SRC).toContain('href: "/cpap-masks/fisher-paykel"');
  });
});

describe("cpap-masks — brand badges", () => {
  it("marks React Health as 'Best Overall'", () => {
    expect(SRC).toContain("Best Overall");
  });

  it("marks ResMed as 'Most Popular'", () => {
    expect(SRC).toContain("Most Popular");
  });

  it("marks Fisher & Paykel as 'Best for Movers'", () => {
    expect(SRC).toContain("Best for Movers");
  });
});

describe("cpap-masks — brand data — React Health", () => {
  it("lists Rio II Nasal Pillow as a flagship mask", () => {
    expect(SRC).toContain("Rio II Nasal Pillow");
  });

  it("lists Numa Full Face as a flagship mask", () => {
    expect(SRC).toContain("Numa Full Face");
  });

  it("includes 'Engineered in Florida' highlight", () => {
    expect(SRC).toContain("Engineered in Florida");
  });
});

describe("cpap-masks — brand data — ResMed", () => {
  it("lists AirFit F30i as a flagship mask", () => {
    expect(SRC).toContain("AirFit F30i");
  });

  it("lists AirFit P10 as a flagship mask", () => {
    expect(SRC).toContain("AirFit P10");
  });

  it("includes 'Industry-leading sizing matrix' highlight", () => {
    expect(SRC).toContain("Industry-leading sizing matrix");
  });
});

describe("cpap-masks — brand data — Fisher & Paykel", () => {
  it("lists Evora as a flagship mask", () => {
    expect(SRC).toContain("Evora");
  });

  it("lists Brevida as a flagship mask", () => {
    expect(SRC).toContain("Brevida");
  });

  it("includes 'RollFit auto-adjusting seal' highlight", () => {
    expect(SRC).toContain("RollFit auto-adjusting seal");
  });
});

describe("cpap-masks — quick-recommendation cheat sheet", () => {
  it("recommends React Health for 'New to CPAP' users", () => {
    expect(SRC).toContain("New to CPAP");
    // The link must point to /cpap-masks/react-health, not /masks.
    const newToCpapIdx = SRC.indexOf("New to CPAP");
    const nextHrefMatch = SRC.slice(newToCpapIdx).match(/href:\s*"([^"]+)"/);
    expect(nextHrefMatch?.[1]).toBe("/cpap-masks/react-health");
  });

  it("recommends ResMed for 'Hard-to-fit faces'", () => {
    expect(SRC).toContain("Hard-to-fit faces");
    const idx = SRC.indexOf("Hard-to-fit faces");
    const nextHrefMatch = SRC.slice(idx).match(/href:\s*"([^"]+)"/);
    expect(nextHrefMatch?.[1]).toBe("/cpap-masks/resmed");
  });

  it("recommends Fisher & Paykel for 'Side or stomach sleepers'", () => {
    expect(SRC).toContain("Side or stomach sleepers");
    const idx = SRC.indexOf("Side or stomach sleepers");
    const nextHrefMatch = SRC.slice(idx).match(/href:\s*"([^"]+)"/);
    expect(nextHrefMatch?.[1]).toBe("/cpap-masks/fisher-paykel");
  });
});

describe("cpap-masks — CTA data-testids", () => {
  it("marks the hero fitter CTA with brands-cta-fit", () => {
    expect(SRC).toContain('"brands-cta-fit"');
  });

  it("marks the hero catalog CTA with brands-cta-catalog", () => {
    expect(SRC).toContain('"brands-cta-catalog"');
  });

  it("marks the bottom fitter CTA with brands-bottom-cta-fit", () => {
    expect(SRC).toContain('"brands-bottom-cta-fit"');
  });
});

describe("cpap-masks — navigation targets", () => {
  it("navigates to /consent when the fitter CTA is clicked", () => {
    expect(SRC).toContain('navigate("/consent")');
  });

  it("navigates to /masks when the catalog CTA is clicked", () => {
    expect(SRC).toContain('navigate("/masks")');
  });
});
