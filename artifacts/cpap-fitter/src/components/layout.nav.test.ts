// Tests for components/layout.tsx — primary navigation structure.
//
// The header nav is a flat, task-oriented list (Get fitted, Order, Masks,
// Track, Help) so new patients can scan it quickly. Brand mask pages, FAQ,
// and the article library live in the footer and /help hub.
//
// Static source analysis (same approach as AppShell.nav.test.ts) because
// the node Vitest environment has no DOM.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");

function navLinksBlock(): string {
  const navStart = SRC.indexOf("const navLinks");
  const navEnd = SRC.indexOf("];", navStart);
  expect(navStart).toBeGreaterThanOrEqual(0);
  expect(navEnd).toBeGreaterThan(navStart);
  return SRC.slice(navStart, navEnd + 2);
}

// ---------------------------------------------------------------------------
// Primary navLinks array — header navigation (desktop + mobile)
// ---------------------------------------------------------------------------

describe("layout.tsx — primary navLinks array", () => {
  it("defines a flat navLinks array", () => {
    expect(SRC).toContain("const navLinks: NavLink[]");
  });

  it("includes /how-it-works with label 'Get fitted'", () => {
    const block = navLinksBlock();
    expect(block).toContain('href: "/how-it-works"');
    expect(block).toContain('"Get fitted"');
  });

  it("includes /insurance with label 'Order'", () => {
    const block = navLinksBlock();
    expect(block).toContain('href: "/insurance"');
    expect(block).toContain('"Order"');
  });

  it("includes /masks with label 'Masks'", () => {
    const block = navLinksBlock();
    expect(block).toContain('href: "/masks"');
    expect(block).toContain('"Masks"');
  });

  it("includes /track-order with label 'Track'", () => {
    const block = navLinksBlock();
    expect(block).toContain('href: "/track-order"');
    expect(block).toContain('"Track"');
  });

  it("includes /help with label 'Help'", () => {
    const block = navLinksBlock();
    expect(block).toContain('href: "/help"');
    expect(block).toContain('"Help"');
  });

  it("does NOT use a Masks dropdown group in the primary nav", () => {
    const block = navLinksBlock();
    expect(block).not.toContain("children:");
    expect(block).not.toContain("NavDropdown");
  });

  it("does NOT include /learn in the primary nav (footer + help hub)", () => {
    const block = navLinksBlock();
    expect(block).not.toContain('href: "/learn"');
  });

  it("does NOT include FAQ in the primary nav (nested under Help)", () => {
    const block = navLinksBlock();
    expect(block).not.toContain('"/faq"');
    expect(block).not.toContain('label: "FAQ"');
  });

  it("does NOT include /stories in the primary nav (footer-only link)", () => {
    const block = navLinksBlock();
    expect(block).not.toContain('"/stories"');
  });
});

// ---------------------------------------------------------------------------
// Mobile navigation
// ---------------------------------------------------------------------------

describe("layout.tsx — mobile navigation", () => {
  it("renders a mobile-nav-panel id for the dropdown", () => {
    expect(SRC).toContain('id="mobile-nav-panel"');
  });

  it("uses a hamburger button with data-testid='button-mobile-menu'", () => {
    expect(SRC).toContain('data-testid="button-mobile-menu"');
  });

  it("toggles aria-expanded on the mobile menu button", () => {
    expect(SRC).toContain("aria-expanded={mobileOpen}");
  });

  it("aria-controls points to the mobile-nav-panel id", () => {
    expect(SRC).toContain('aria-controls="mobile-nav-panel"');
  });

  it("mobile link data-testid follows the 'mobile-link-{href}' pattern", () => {
    expect(SRC).toContain("mobile-link-");
  });
});

// ---------------------------------------------------------------------------
// Desktop navigation — accessibility attributes
// ---------------------------------------------------------------------------

describe("layout.tsx — desktop nav accessibility", () => {
  it("uses aria-current='page' on the active route", () => {
    expect(SRC).toContain('aria-current={isActive ? "page" : undefined}');
  });

  it("uses data-testid='nav-{href}' pattern for desktop nav items", () => {
    expect(SRC).toContain("data-testid={`nav-${l.href.replace(/\\//g");
  });

  it("renders a skip-to-content link targeting #main-content", () => {
    expect(SRC).toContain('href="#main-content"');
    expect(SRC).toContain("Skip to main content");
  });

  it("main landmark has id='main-content' for skip link target", () => {
    expect(SRC).toContain('id="main-content"');
  });

  it("main landmark has tabIndex={-1} for programmatic focus via skip link", () => {
    expect(SRC).toContain("tabIndex={-1}");
  });
});

// ---------------------------------------------------------------------------
// Footer navigation — "Learn & Resources" column
// ---------------------------------------------------------------------------

describe("layout.tsx — footer 'Learn & Resources' column", () => {
  it("includes the 'Learn & Resources' section heading", () => {
    expect(SRC).toContain("Learn");
    expect(SRC).toContain("Resources");
  });

  it("includes /sleep-apnea-101 link for 'Sleep apnea 101'", () => {
    expect(SRC).toContain('href="/sleep-apnea-101"');
    expect(SRC).toContain("Sleep apnea 101");
  });

  it("includes /learn link for 'Article library'", () => {
    expect(SRC).toContain("Article library");
  });

  it("includes /learn/glossary link for 'CPAP glossary'", () => {
    expect(SRC).toContain('href="/learn/glossary"');
    expect(SRC).toContain("CPAP glossary");
  });

  it("surfaces brand mask pages in the footer", () => {
    expect(SRC).toContain('href="/cpap-masks/resmed"');
    expect(SRC).toContain('href="/cpap-masks/react-health"');
    expect(SRC).toContain('href="/cpap-masks/fisher-paykel"');
  });

  it("includes /stories link with 'Patient stories' label in footer", () => {
    expect(SRC).toContain('href="/stories"');
    expect(SRC).toContain("Patient stories");
  });

  it("includes /learn/sleep-apnea-quiz for 'Self-screener'", () => {
    expect(SRC).toContain('href="/learn/sleep-apnea-quiz"');
    expect(SRC).toContain("Self-screener");
  });
});

// ---------------------------------------------------------------------------
// Footer navigation — "Patient Services" column
// ---------------------------------------------------------------------------

describe("layout.tsx — footer 'Patient Services' column", () => {
  it("includes /how-it-works link in footer Patient Services", () => {
    const count = (SRC.match(/href="\/how-it-works"/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("includes /masks link for 'Mask catalog'", () => {
    expect(SRC).toContain('href="/masks"');
    expect(SRC).toContain("Mask catalog");
  });

  it("includes /insurance link in footer", () => {
    expect(SRC).toContain("Order through insurance");
  });

  it("includes /insurance/estimate link", () => {
    expect(SRC).toContain('href="/insurance/estimate"');
    expect(SRC).toContain("Insurance estimate");
  });

  it("includes /account link for 'My Account'", () => {
    expect(SRC).toContain('href="/account"');
    expect(SRC).toContain("My Account");
  });

  it("includes /track-order link", () => {
    expect(SRC).toContain('href="/track-order"');
    expect(SRC).toContain("Track an order");
  });

  it("includes /reminders link", () => {
    expect(SRC).toContain('href="/reminders"');
    expect(SRC).toContain("Resupply reminders");
  });

  it("includes /faq and /contact links", () => {
    expect(SRC).toContain('href="/faq"');
    expect(SRC).toContain('href="/contact"');
  });

  it("links comfort guarantee instead of a broken /returns route", () => {
    expect(SRC).toContain('href="/comfort-guarantee"');
    expect(SRC).not.toContain('href="/returns"');
  });

  it("uses the insurance-only footer tagline", () => {
    expect(SRC).toContain("Fit · Order · Resupply");
    expect(SRC).not.toContain("Fit · Shop · Resupply");
  });
});

// ---------------------------------------------------------------------------
// Footer — bottom bar: copyright and staff sign-in
// ---------------------------------------------------------------------------

describe("layout.tsx — footer bottom bar", () => {
  it("includes staff sign-in link pointing to /admin/sign-in", () => {
    expect(SRC).toContain('href="/admin/sign-in"');
    expect(SRC).toContain("Staff sign-in");
  });

  it("uses data-testid='footer-staff-signin' on the staff sign-in link", () => {
    expect(SRC).toContain('data-testid="footer-staff-signin"');
  });

  it("includes copyright text referencing the (per-tenant) legal name", () => {
    expect(SRC).toContain("{branding.legalName}");
    expect(SRC).toContain("Licensed DME");
  });
});

// ---------------------------------------------------------------------------
// Additional components rendered by Layout
// ---------------------------------------------------------------------------

describe("layout.tsx — auxiliary components", () => {
  it("mounts ScrollToTop inside the layout", () => {
    expect(SRC).toContain("ScrollToTop");
  });

  it("mounts FloatingContactLauncher after the footer", () => {
    expect(SRC).toContain("FloatingContactLauncher");
  });

  it("mounts MobileCtaBar", () => {
    expect(SRC).toContain("MobileCtaBar");
  });

  it("mounts KeyboardShortcutsDialog", () => {
    expect(SRC).toContain("KeyboardShortcutsDialog");
  });

  it("mounts FitFlowStepper between header and main", () => {
    expect(SRC).toContain("FitFlowStepper");
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe("layout.tsx — module exports", () => {
  it("exports Layout as a named export", () => {
    expect(SRC).toContain("export function Layout(");
  });
});
