// Tests for components/layout.tsx — primary navigation structure.
//
// The header nav groups the three mask-discovery surfaces (Mask
// Catalog + the brand landings) under one "Masks" dropdown, keeps
// Virtual Mask Fitter and Shop as their own items, and nests FAQ
// under the /help hub (so it's no longer a top-level bar item). The
// footer still carries the "/stories" Patient stories link.
//
// We test the source file statically (same approach as AppShell.nav.test.ts)
// because the node Vitest environment has no DOM and React components cannot
// be rendered without jsdom.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Primary navLinks array — header navigation (desktop + mobile)
// ---------------------------------------------------------------------------

describe("layout.tsx — primary navLinks array", () => {
  it("defines a navLinks array", () => {
    expect(SRC).toContain("const navLinks");
  });

  it("includes /how-it-works with label 'Virtual Mask Fitter'", () => {
    expect(SRC).toContain('href: "/how-it-works"');
    expect(SRC).toContain("Virtual Mask Fitter");
  });

  it("includes /masks with label 'Mask Catalog' (under Masks group)", () => {
    expect(SRC).toContain('href: "/masks"');
    expect(SRC).toContain("Mask Catalog");
  });

  it("includes /cpap-masks with label 'Brands' (under Masks group)", () => {
    expect(SRC).toContain('href: "/cpap-masks"');
    expect(SRC).toContain('"Brands"');
  });

  it("includes /shop with label 'Shop'", () => {
    expect(SRC).toContain('href: "/shop"');
    expect(SRC).toContain('"Shop"');
  });

  it("includes /learn with label 'Learn'", () => {
    expect(SRC).toContain('href: "/learn"');
    expect(SRC).toContain('"Learn"');
  });

  it("includes /help with label 'Help'", () => {
    expect(SRC).toContain('href: "/help"');
    expect(SRC).toContain('"Help"');
  });

  // FAQ was removed from the primary nav and nested under the /help
  // hub (which carries a prominent "Browse the FAQ" card) plus the
  // mobile "Talk to us" bar — so the top bar has one support entry.
  it("does NOT include FAQ in the primary navLinks (nested under Help)", () => {
    const navStart = SRC.indexOf("const navLinks");
    const navEnd = SRC.indexOf("];", navStart);
    expect(navStart).toBeGreaterThanOrEqual(0);
    expect(navEnd).toBeGreaterThan(navStart);
    const navLinksBlock = SRC.slice(navStart, navEnd + 2);
    expect(navLinksBlock).not.toContain('"/faq"');
    expect(navLinksBlock).not.toContain('label: "FAQ"');
  });

  it("does NOT include /stories in the primary navLinks (footer-only link)", () => {
    // /stories should only be in the footer, not in the primary navLinks array
    // We check the navLinks block specifically (the array before the component)
    const navStart = SRC.indexOf("const navLinks");
    const navEnd = SRC.indexOf("];", navStart);
    expect(navStart).toBeGreaterThanOrEqual(0);
    expect(navEnd).toBeGreaterThan(navStart);
    const navLinksBlock = SRC.slice(navStart, navEnd + 2);
    expect(navLinksBlock).not.toContain('"/stories"');
  });
});

// ---------------------------------------------------------------------------
// Masks dropdown — the three mask-discovery surfaces (spec catalog +
// brand landings) are grouped under one "Masks" menu, and the brand
// sub-pages are surfaced in it so they're reachable from the nav (not
// only by clicking through /cpap-masks).
// ---------------------------------------------------------------------------

describe("layout.tsx — Masks dropdown group", () => {
  it("defines a 'Masks' group label", () => {
    expect(SRC).toContain('label: "Masks"');
  });

  it("surfaces the three brand sub-pages in the dropdown", () => {
    expect(SRC).toContain('href: "/cpap-masks/resmed"');
    expect(SRC).toContain('href: "/cpap-masks/react-health"');
    expect(SRC).toContain('href: "/cpap-masks/fisher-paykel"');
  });

  it("renders the dropdown trigger with data-testid='nav-masks-menu'", () => {
    expect(SRC).toContain('data-testid="nav-masks-menu"');
  });

  it("the dropdown trigger is a menu button (aria-haspopup='menu')", () => {
    expect(SRC).toContain('aria-haspopup="menu"');
  });

  it("renders grouped entries via a NavDropdown / isNavGroup branch", () => {
    expect(SRC).toContain("NavDropdown");
    expect(SRC).toContain("isNavGroup");
  });
});

// ---------------------------------------------------------------------------
// Mobile navigation — mobile nav links use navLinks array
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

  it("includes /cpap-masks footer link for 'Mask brands'", () => {
    expect(SRC).toContain("Mask brands");
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
    // Appears in navLinks and in footer
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("includes /shop link in footer", () => {
    expect(SRC).toContain("Shop Supplies");
  });

  it("includes /account link for 'My Account'", () => {
    expect(SRC).toContain('href="/account"');
    expect(SRC).toContain("My Account");
  });

  it("includes /track-order link", () => {
    expect(SRC).toContain('href="/track-order"');
    expect(SRC).toContain("Track an order");
  });

  it("includes /returns link", () => {
    expect(SRC).toContain('href="/returns"');
    expect(SRC).toContain("Returns");
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

  it("includes copyright text referencing Penn Home Medical Supply", () => {
    expect(SRC).toContain("Penn Home Medical Supply");
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

  it("renders WishlistNavLink in the header", () => {
    expect(SRC).toContain("WishlistNavLink");
  });

  it("renders MiniCart in the header", () => {
    expect(SRC).toContain("MiniCart");
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
