// Tests for the navLinks change in components/layout.tsx
//
// PR change: added { href: "/cpap-masks", label: "Brands" } between
// "Mask Catalog" and "Shop" in the desktop/mobile navigation.
//
// The layout component itself cannot be rendered in the node vitest
// environment (no DOM/React). We use static source analysis instead.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");

// ---------------------------------------------------------------------------
// navLinks array — structural verification
// ---------------------------------------------------------------------------

describe("layout — navLinks includes new Brands entry", () => {
  it('contains an entry with href "/cpap-masks"', () => {
    expect(SRC).toContain('href: "/cpap-masks"');
  });

  it('labels the /cpap-masks link "Brands"', () => {
    expect(SRC).toContain('label: "Brands"');
  });

  it("has exactly six nav link entries (including the new Brands link)", () => {
    // Count distinct href occurrences in the navLinks array.
    // We look for the pattern used in the constant, not inside JSX href attributes.
    const matches = SRC.match(/href: "\/[^"]+"/g);
    // The navLinks array has 6 items; other href: occurrences (footer) are
    // not in this exact format so the count should match exactly.
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(6);
  });
});

describe("layout — navLinks ordering", () => {
  it('places "Brands" (/cpap-masks) after "Mask Catalog" (/masks)', () => {
    const masksIndex = SRC.indexOf('href: "/masks"');
    const cpapMasksIndex = SRC.indexOf('href: "/cpap-masks"');
    expect(masksIndex).toBeGreaterThan(-1);
    expect(cpapMasksIndex).toBeGreaterThan(-1);
    expect(cpapMasksIndex).toBeGreaterThan(masksIndex);
  });

  it('places "Brands" (/cpap-masks) before "Shop" (/shop)', () => {
    const cpapMasksIndex = SRC.indexOf('href: "/cpap-masks"');
    const shopIndex = SRC.indexOf('href: "/shop"');
    expect(cpapMasksIndex).toBeGreaterThan(-1);
    expect(shopIndex).toBeGreaterThan(-1);
    expect(cpapMasksIndex).toBeLessThan(shopIndex);
  });

  it("still contains all previously-existing nav link hrefs", () => {
    for (const href of ["/how-it-works", "/masks", "/shop", "/learn", "/faq"]) {
      expect(SRC).toContain(`href: "${href}"`);
    }
  });
});

describe("layout — active-route detection uses startsWith for nested routes", () => {
  it("uses location.startsWith to mark parent nav items as active on sub-routes", () => {
    // This ensures /cpap-masks/react-health keeps the Brands nav item
    // highlighted — the same pattern used for /learn/* etc.
    expect(SRC).toContain("location.startsWith(`${l.href}/`)");
  });
});

describe("layout — data-testid for nav links", () => {
  it('generates data-testid attributes using the href (stripped of slashes)', () => {
    // The desktop nav renders data-testid={`nav-${l.href.replace(/\//g, "")}`}
    // so /cpap-masks → nav-cpap-masks.
    expect(SRC).toContain('`nav-${l.href.replace(/\\//g, "")}`');
  });

  it("also assigns data-testid attributes on mobile nav links", () => {
    // Mobile links use a different template: mobile-link-${l.href.replace("/", "")}
    expect(SRC).toContain('`mobile-link-${l.href.replace("/", "")}`');
  });
});