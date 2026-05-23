// Tests for components/layout.tsx — navLinks change
//
// This PR added the "/cpap-masks" → "Brands" entry to the navLinks array.
// We test the source file statically (same approach as admin.scope.test.ts
// and use-url-state.test.ts) because the node vitest environment has no
// DOM and we cannot render React components.
//
// The goal is to guarantee that:
//   1. The new "Brands" link is present in the navLinks array.
//   2. Its href is exactly "/cpap-masks" (matches the registered route in App.tsx).
//   3. The array order is correct — "Brands" sits between "Mask Catalog" and "Shop".
//   4. All six expected nav items are present.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Extract the navLinks literal from the source so we can reason about order.
// We look for the block between `const navLinks = [` and the matching `];`.
// ---------------------------------------------------------------------------

function extractNavLinksSrc(src: string): string {
  const start = src.indexOf("const navLinks = [");
  if (start === -1) throw new Error("navLinks not found in layout.tsx");
  // Find the matching closing bracket.
  let depth = 0;
  let i = src.indexOf("[", start);
  const begin = i;
  while (i < src.length) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return src.slice(begin, i + 1);
    }
    i++;
  }
  throw new Error("Could not find end of navLinks array");
}

const navLinksSrc = extractNavLinksSrc(SRC);

// ---------------------------------------------------------------------------
// Extract individual href/label pairs in order.
// ---------------------------------------------------------------------------

function parseNavLinks(
  src: string,
): Array<{ href: string; label: string }> {
  const re = /href:\s*"([^"]+)"[^}]*label:\s*"([^"]+)"/g;
  const links: Array<{ href: string; label: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    links.push({ href: m[1]!, label: m[2]! });
  }
  return links;
}

const navLinks = parseNavLinks(navLinksSrc);

describe("layout navLinks — all expected entries present", () => {
  it("contains a 'Virtual Mask Fitter' link to /how-it-works", () => {
    const link = navLinks.find((l) => l.href === "/how-it-works");
    expect(link).toBeDefined();
    expect(link?.label).toBe("Virtual Mask Fitter");
  });

  it("contains a 'Mask Catalog' link to /masks", () => {
    const link = navLinks.find((l) => l.href === "/masks");
    expect(link).toBeDefined();
    expect(link?.label).toBe("Mask Catalog");
  });

  it("contains the new 'Brands' link to /cpap-masks (added in this PR)", () => {
    const link = navLinks.find((l) => l.href === "/cpap-masks");
    expect(link).toBeDefined();
    expect(link?.label).toBe("Brands");
  });

  it("contains a 'Shop' link to /shop", () => {
    const link = navLinks.find((l) => l.href === "/shop");
    expect(link).toBeDefined();
    expect(link?.label).toBe("Shop");
  });

  it("contains a 'Learn' link to /learn", () => {
    const link = navLinks.find((l) => l.href === "/learn");
    expect(link).toBeDefined();
    expect(link?.label).toBe("Learn");
  });

  it("contains a 'FAQ' link to /faq", () => {
    const link = navLinks.find((l) => l.href === "/faq");
    expect(link).toBeDefined();
    expect(link?.label).toBe("FAQ");
  });

  it("has exactly six nav links", () => {
    expect(navLinks.length).toBe(6);
  });
});

describe("layout navLinks — ordering", () => {
  it("lists Virtual Mask Fitter before Mask Catalog", () => {
    const howIdx = navLinks.findIndex((l) => l.href === "/how-it-works");
    const masksIdx = navLinks.findIndex((l) => l.href === "/masks");
    expect(howIdx).toBeLessThan(masksIdx);
  });

  it("lists Mask Catalog before the new Brands entry", () => {
    const masksIdx = navLinks.findIndex((l) => l.href === "/masks");
    const brandsIdx = navLinks.findIndex((l) => l.href === "/cpap-masks");
    expect(masksIdx).toBeLessThan(brandsIdx);
  });

  it("lists Brands before Shop", () => {
    const brandsIdx = navLinks.findIndex((l) => l.href === "/cpap-masks");
    const shopIdx = navLinks.findIndex((l) => l.href === "/shop");
    expect(brandsIdx).toBeLessThan(shopIdx);
  });

  it("lists Shop before Learn", () => {
    const shopIdx = navLinks.findIndex((l) => l.href === "/shop");
    const learnIdx = navLinks.findIndex((l) => l.href === "/learn");
    expect(shopIdx).toBeLessThan(learnIdx);
  });

  it("lists Learn before FAQ", () => {
    const learnIdx = navLinks.findIndex((l) => l.href === "/learn");
    const faqIdx = navLinks.findIndex((l) => l.href === "/faq");
    expect(learnIdx).toBeLessThan(faqIdx);
  });
});

describe("layout navLinks — source-level structural checks", () => {
  it("exports the Layout component", () => {
    expect(SRC).toContain("export function Layout");
  });

  it("uses navLinks in the desktop nav render", () => {
    // The nav maps over navLinks — confirm the iteration is present.
    expect(SRC).toContain("navLinks.map");
  });

  it("uses navLinks in the mobile nav panel as well", () => {
    // Both desktop and mobile navs iterate navLinks, so count >= 2.
    const count = (SRC.match(/navLinks\.map/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("generates data-testid from the href slug for each nav link", () => {
    // desktop: data-testid={`nav-${l.href.replace(/\//g, "")}`}
    expect(SRC).toContain("nav-${l.href.replace(/\\//g, \"\")}");
  });
});