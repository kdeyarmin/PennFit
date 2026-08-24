// Tests for the catalog-coverage section of pages/breathe-mask-fitting.tsx —
// the manufacturer roster a prospective DME reads to answer "does it already
// know the masks I dispense?".
//
// Static source analysis (same approach as the other marketing-page specs —
// this page imports the whole Breathe shell, so mounting it in jsdom would
// test the chrome rather than the section). The parsing and the snapshot
// numbers are covered behaviourally in lib/mask-catalog-coverage.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "breathe-mask-fitting.tsx"),
  "utf8",
);

describe("catalog coverage — wiring", () => {
  it("renders the section on the page", () => {
    expect(SRC).toContain("<CatalogCoverageSection />");
    expect(SRC).toContain('id="catalog"');
  });

  it("reads the roster through the shared coverage hook", () => {
    // Fetching, parsing and the fallback snapshot all live in the shared
    // module (covered behaviourally in lib/mask-catalog-coverage.test.ts) so
    // the home teaser and this page can never quote different totals.
    expect(SRC).toContain('from "@/lib/mask-catalog-coverage"');
    expect(SRC).toContain("useMaskCatalogCoverage()");
    expect(SRC).not.toContain("fetch(");
  });

  it("only claims a live count when live numbers actually landed", () => {
    // The section's argument is that the numbers are counted rather than
    // asserted, so the badge must never sit above the static snapshot.
    expect(SRC).toContain(
      "const { coverage, isLive } = useMaskCatalogCoverage()",
    );
    expect(SRC).toContain("{isLive && (");
  });
});

describe("catalog coverage — render invariants", () => {
  const SECTION = SRC.slice(
    SRC.indexOf("function CatalogCoverageSection()"),
    SRC.indexOf("/* ── Referral network ── */"),
  );

  it("has a section to slice (guards the two anchors above)", () => {
    expect(SECTION.length).toBeGreaterThan(500);
  });

  it("never puts bx-reveal on a row that only appears once live data lands", () => {
    // useRevealOnScroll (breathe.tsx) observes `.bx-reveal` ONCE on mount,
    // so an element created later never receives `.in` and stays at
    // opacity: 0 forever. Rows and chips are re-keyed by the live payload,
    // so they must not carry the class.
    for (const cls of ["bx-mfg-row", "bx-mfg-type", "bx-mfg-total"]) {
      const rowMarkup = SECTION.slice(SECTION.indexOf(cls));
      expect(rowMarkup.slice(0, cls.length + 40).includes("bx-reveal")).toBe(
        false,
      );
    }
    // The stable wrapper, which exists from first paint, does carry it.
    expect(SECTION).toContain('className="bx-mfg-panel bx-reveal"');
  });

  it("hides a child-count tile rather than printing a zero it can't stand behind", () => {
    expect(SECTION).toContain("totals.sizeVariants != null &&");
    expect(SECTION).toContain("totals.components != null &&");
  });

  it("formats counts with thousands separators", () => {
    expect(SECTION).toContain('toLocaleString("en-US")');
  });

  it("scales the share bar to the widest roster, guarding a divide-by-zero", () => {
    expect(SECTION).toContain("Math.max(1, ...manufacturers.map");
  });

  it("marks the decorative share bar aria-hidden", () => {
    expect(SECTION).toContain('aria-hidden="true"');
  });

  it("singularises the one-model manufacturers", () => {
    expect(SECTION).toContain('m.models === 1 ? "model" : "models"');
  });

  it("shows the current / discontinued split behind the headline total", () => {
    expect(SECTION).toContain("currently marketed");
    expect(SECTION).toContain("n(totals.discontinuedModels)");
  });

  it("uses a class rather than an inline style for section spacing", () => {
    expect(SECTION).toContain('className="bx-caps bx-mfg-notes"');
    expect(SECTION).not.toContain("style={{ marginTop");
  });

  it("omits the freshness date when the endpoint didn't supply one", () => {
    expect(SECTION).toContain(
      "updatedLabel ? `, last updated ${updatedLabel}`",
    );
  });

  it("tolerates an unparseable lastUpdatedAt", () => {
    expect(SECTION).toContain("Number.isNaN(updated.getTime())");
  });
});

describe("catalog coverage — claims", () => {
  it("says new masks are added centrally and reach every tenant", () => {
    expect(SRC).toContain("New masks arrive already loaded");
    expect(SRC).toMatch(/shared platform data/i);
  });

  it("explains why discontinued models are kept", () => {
    expect(SRC).toMatch(/discontinued models stay in the catalog on purpose/i);
  });

  it("frames the count as read from the catalog, not a marketing figure", () => {
    expect(SRC).toMatch(/not a\s*\n?\s*marketing figure/i);
  });

  it("does not promise a self-serve 'add your own model' flow", () => {
    // The admin catalog route (routes/admin/mask-catalog.ts) exposes edits
    // and clinical sign-off, but no create-a-model endpoint — so the page
    // must not imply one.
    expect(SRC).not.toMatch(/add your own (mask|model)/i);
  });
});
