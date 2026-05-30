// Tests for components/layout.tsx — footer changes in this PR
//
// This PR added a "/stories" → "Patient stories" link to the footer
// navigation in the Layout component.
//
// We test the source file statically (same approach as AppShell.nav.test.ts)
// because the node vitest environment has no DOM and React components cannot
// be rendered without jsdom.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");

// ---------------------------------------------------------------------------
// New Patient stories link added in this PR
// ---------------------------------------------------------------------------

describe("layout.tsx — Patient stories link added to footer", () => {
  it("includes href='/stories' in the footer", () => {
    expect(SRC).toContain('href="/stories"');
  });

  it("uses 'Patient stories' as the link label", () => {
    expect(SRC).toContain("Patient stories");
  });

  it("wraps the Patient stories link in a <li> element", () => {
    // The footer nav items are <li><Link ...>label</Link></li>
    const storiesIdx = SRC.indexOf('href="/stories"');
    expect(storiesIdx).toBeGreaterThanOrEqual(0);
    // Check there is a <li> before the link in close proximity.
    // Lookback is generous so Prettier's multi-line JSX (the <li>,
    // <Link>, and href land on separate indented lines) still falls
    // inside the window.
    const surrounding = SRC.slice(
      Math.max(0, storiesIdx - 200),
      storiesIdx + 200,
    );
    expect(surrounding).toContain("<li>");
    expect(surrounding).toContain("Patient stories");
  });

  it("uses the same muted-foreground hover styling as other footer links", () => {
    // The pattern used by adjacent footer links
    const storiesIdx = SRC.indexOf('href="/stories"');
    expect(storiesIdx).toBeGreaterThanOrEqual(0);
    const linkBlock = SRC.slice(storiesIdx, storiesIdx + 200);
    expect(linkBlock).toContain("text-muted-foreground hover:text-primary");
  });
});

// ---------------------------------------------------------------------------
// Regression: other footer links are undisturbed
// ---------------------------------------------------------------------------

describe("layout.tsx — pre-existing footer links not regressed", () => {
  it("still has the 'Mask brands' link", () => {
    expect(SRC).toContain("Mask brands");
  });

  it("still links to /learn/sleep-apnea-quiz in footer", () => {
    expect(SRC).toContain("/learn/sleep-apnea-quiz");
  });

  it("still exports the Layout component", () => {
    expect(SRC).toContain("export function Layout");
  });

  it("still has the CPAP glossary link in the footer", () => {
    expect(SRC).toContain("CPAP glossary");
  });
});
