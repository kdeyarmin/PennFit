// Tests for pages/home.tsx — editorial hero redesign
//
// PR change: the hero section was restyled from a Penn-navy dark card
// to a light editorial card. Key structural changes:
//   * New hero-eyebrow div (aria-hidden) with rule/mark/text spans
//   * h1 uses text-foreground (was text-white)
//   * "simple" wrapped in a hero-headline-italic span
//   * Paragraph text uses text-muted-foreground (was text-white/80)
//   * Inline bold spans use text-foreground (was text-white)
//   * Primary CTA removed btn-gold-glow class
//   * Secondary CTA removed btn-on-dark-outline class
//   * Ask PennBot button uses text-muted-foreground hover:text-foreground
//     (was text-white/70 hover:text-white)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "home.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Hero eyebrow — new editorial typographic mark above the headline
// ---------------------------------------------------------------------------

describe("home — hero-eyebrow element", () => {
  it("renders the hero-eyebrow div with aria-hidden", () => {
    expect(SRC).toContain('className="hero-eyebrow" aria-hidden="true"');
  });

  it("includes at least two hero-eyebrow-rule spans", () => {
    // One on each side of the eyebrow text
    const ruleMatches = SRC.match(/className="hero-eyebrow-rule"/g) ?? [];
    expect(ruleMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("includes at least two hero-eyebrow-mark spans", () => {
    // One on each side of the centre text
    const markMatches = SRC.match(/className="hero-eyebrow-mark"/g) ?? [];
    expect(markMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the 'Penn Home Medical Supply · CPAP Care' label", () => {
    expect(SRC).toContain("Penn Home Medical Supply");
    expect(SRC).toContain("CPAP Care");
  });

  it("eyebrow content sits before the h1 in source order", () => {
    const eyebrowIdx = SRC.indexOf("hero-eyebrow");
    const h1Idx = SRC.indexOf("<h1 ");
    expect(eyebrowIdx).toBeGreaterThan(0);
    expect(eyebrowIdx).toBeLessThan(h1Idx);
  });
});

// ---------------------------------------------------------------------------
// H1 — italic accent and text-foreground class
// ---------------------------------------------------------------------------

describe("home — h1 headline", () => {
  it("h1 uses text-foreground (light surface, navy ink)", () => {
    // The old hero used text-white on the dark navy card.
    expect(SRC).toMatch(/h1[^>]*text-foreground/);
  });

  it("h1 does NOT use the legacy text-white class on the headline", () => {
    // Regression guard: ensure the dark-card era class is gone.
    const h1Match = SRC.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    expect(h1Match?.[0] ?? "").not.toContain('text-white"');
  });

  it("wraps 'simple' in a hero-headline-italic span", () => {
    expect(SRC).toContain('className="hero-headline-italic"');
  });

  it("the hero-headline-italic span contains the word 'simple'", () => {
    const italicMatch = SRC.match(
      /className="hero-headline-italic"[^>]*>([\s\S]*?)<\/span>/,
    );
    expect(italicMatch?.[0] ?? "").toContain("simple");
  });

  it("still contains the hero-headline-swoosh span for 'Fit. Shop. Resupply.'", () => {
    expect(SRC).toContain("hero-headline-swoosh");
    expect(SRC).toContain("Fit. Shop. Resupply.");
  });
});

// ---------------------------------------------------------------------------
// Body copy — muted foreground instead of white-on-dark colours
// ---------------------------------------------------------------------------

describe("home — hero body copy text colours", () => {
  it("paragraph uses text-muted-foreground (was text-white/80)", () => {
    expect(SRC).toContain("text-muted-foreground");
  });

  it("'PennPaps.com' bold span uses text-foreground (was text-white)", () => {
    // Check that the span wrapping PennPaps.com uses text-foreground.
    const pennPapsMatch = SRC.match(
      /className="font-semibold text-foreground"[^>]*>\s*PennPaps\.com/,
    );
    expect(pennPapsMatch).not.toBeNull();
  });

  it("'Penn Home Medical Supply' bold span uses text-foreground", () => {
    const phmsMatch = SRC.match(
      /className="font-semibold text-foreground"[^>]*>\s*Penn Home Medical Supply/,
    );
    expect(phmsMatch).not.toBeNull();
  });

  it("does NOT use text-white/80 on any paragraph copy", () => {
    expect(SRC).not.toContain("text-white/80");
  });

  it("does NOT use text-white as a standalone class on inline spans", () => {
    // Inline text spans on the light card must not use text-white — the
    // dark-card-era colour would be invisible on the pearl surface.
    expect(SRC).not.toMatch(/className="font-semibold text-white"/);
  });
});

// ---------------------------------------------------------------------------
// CTA buttons — removed dark-card-specific utility classes
// ---------------------------------------------------------------------------

describe("home — hero CTA buttons", () => {
  it("primary 'Get fitted' button does NOT carry the btn-gold-glow class", () => {
    // btn-gold-glow was designed for the dark navy card; on the light card
    // it is no longer needed.
    // (The match below would have anchored a narrower assertion, but a
    // file-wide grep is sufficient and matches the sibling 'Shop' test
    // below; keep the broader form for symmetry.)
    expect(SRC).not.toContain("btn-gold-glow");
  });

  it("secondary 'Shop' button does NOT carry the btn-on-dark-outline class", () => {
    // btn-on-dark-outline was a dark-background-specific override; removed
    // on the light editorial card.
    expect(SRC).not.toContain("btn-on-dark-outline");
  });

  it("primary button retains its data-testid 'home-cta-fit'", () => {
    expect(SRC).toContain('"home-cta-fit"');
  });

  it("secondary button retains its data-testid 'home-cta-shop'", () => {
    expect(SRC).toContain('"home-cta-shop"');
  });

  it("primary button still navigates to /consent", () => {
    expect(SRC).toContain('navigate("/consent")');
  });

  it("secondary button still navigates to /shop", () => {
    expect(SRC).toContain('navigate("/shop")');
  });
});

// ---------------------------------------------------------------------------
// Ask PennBot button — muted foreground on the light surface
// ---------------------------------------------------------------------------

describe("home — 'Ask PennBot' tertiary button", () => {
  it("uses text-muted-foreground (was text-white/70)", () => {
    const btnMatch =
      SRC.match(
        /data-testid="home-ask-pennbot"[\s\S]{0,40}className="[^"]*text-muted-foreground/,
      ) ??
      SRC.match(
        /className="[^"]*text-muted-foreground[^"]*"[\s\S]{0,100}data-testid="home-ask-pennbot"/,
      );
    expect(btnMatch).not.toBeNull();
  });

  it("hover state uses hover:text-foreground (was hover:text-white)", () => {
    const btnSrc = SRC.slice(
      SRC.indexOf('data-testid="home-ask-pennbot"') - 200,
      SRC.indexOf('data-testid="home-ask-pennbot"') + 200,
    );
    expect(btnSrc).toContain("hover:text-foreground");
    expect(btnSrc).not.toContain("hover:text-white");
  });

  it("does NOT use text-white/70 (dark card era class)", () => {
    expect(SRC).not.toContain("text-white/70");
  });

  it("retains its data-testid 'home-ask-pennbot'", () => {
    expect(SRC).toContain('"home-ask-pennbot"');
  });

  it("still calls openPennBot() on click", () => {
    expect(SRC).toContain("openPennBot()");
  });
});
