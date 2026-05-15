import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ShieldCheck, Menu, X, Package, Heart } from "lucide-react";
import pennLogo from "@assets/IMG_2053_1777233708393.jpeg";
import { SignedIn } from "@/lib/identity";
import { UserMenu } from "@/components/user-menu";
import { FitFlowStepper } from "@/components/fit-flow-stepper";
import { MobileCtaBar } from "@/components/mobile-cta-bar";
import { MiniCart } from "@/components/shop/mini-cart";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { FloatingContactLauncher } from "@/components/floating-contact-launcher";
import { useWishlist } from "@/lib/wishlist";
import {
  SUPPORT_EMAIL,
  SUPPORT_HOURS,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_E164,
} from "@/lib/contact";

// Wishlist nav indicator — small heart with count badge that
// only renders once the shopper has saved at least one item, so
// the header stays uncluttered for first-time browsers. Visible
// on both desktop and mobile (the shop affordances cluster
// together on mobile alongside the cart icon).
function WishlistNavLink() {
  const { count } = useWishlist();
  if (count === 0) return null;
  return (
    <Link
      href="/shop/wishlist"
      className="relative inline-flex items-center justify-center h-10 w-10 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary/40 transition-colors"
      aria-label={`Wishlist (${count} saved)`}
      data-testid="nav-wishlist"
    >
      <Heart className="h-5 w-5" />
      <span
        className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))] text-[10px] font-bold leading-[18px] text-center"
        data-testid="nav-wishlist-count"
      >
        {count > 99 ? "99+" : count}
      </span>
    </Link>
  );
}

// Reset scroll to the top on every route change. Without this, navigating
// from a long page (e.g. Results) into a new page leaves the user halfway
// down the document — they often miss the new page's hero entirely.
function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    // Use "auto" (instant) — animated scroll on route change is jarring
    // and can race with route-mount animations.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location]);
  return null;
}

const navLinks = [
  { href: "/how-it-works", label: "Virtual Mask Fitter" },
  { href: "/masks", label: "Mask Catalog" },
  { href: "/shop", label: "Shop" },
  { href: "/learn", label: "Learn" },
  { href: "/faq", label: "FAQ" },
];

// (CartNavIcon was replaced by MiniCart — see
// components/shop/mini-cart.tsx. The header now opens a popover
// with the current cart contents instead of navigating away.)
//
// "Your orders" header link — only rendered for signed-in visitors.
// Lives next to the cart icon so the two shop affordances are
// grouped. Hidden for signed-out visitors so the header stays
// uncluttered for first-time browsers.
function YourOrdersNavLink() {
  return (
    <SignedIn>
      <Link
        href="/shop/orders"
        className="hidden md:inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-sm font-medium text-muted-foreground hover:text-primary hover:bg-secondary/40 transition-colors"
        data-testid="nav-your-orders"
      >
        <Package className="h-4 w-4" aria-hidden="true" />
        Your orders
      </Link>
    </SignedIn>
  );
}

/**
 * Application shell that renders the global header, navigation, fit-flow stepper, main content area, and footer while managing mobile navigation state and accessibility helpers.
 *
 * The component auto-closes the mobile navigation when the route changes, mounts ScrollToTop, provides a skip-to-content link, and renders children inside the main landmark.
 *
 * @param children - Page content to render inside the layout's main region
 * @returns The layout element containing header, navigation, main content, and footer
 */
export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auto-close the mobile menu whenever the route changes — otherwise
  // tapping a link leaves the menu drawer open over the new page.
  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  return (
    <div className="min-h-[100dvh] flex flex-col text-foreground">
      <ScrollToTop />
      {/*
        Skip-to-content link. Hidden visually until a keyboard user focuses it
        with the very first Tab press, at which point it becomes a clearly
        labelled bypass-block per WCAG 2.1 SC 2.4.1. Targets the <main>
        landmark below, which has tabIndex={-1} so the browser will move focus
        into it (not just scroll) when the link fires.
      */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-primary focus:ring-offset-2"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-50 w-full">
        <div className="glass-panel border-x-0 border-t-0 border-b border-border/40">
          <div className="container mx-auto flex h-16 md:h-20 items-center justify-between px-4 md:px-6">
            <Link
              href="/"
              className="flex items-center gap-3 transition-opacity hover:opacity-80"
            >
              <div className="relative">
                <div
                  className="absolute -inset-1 rounded-xl bg-gradient-to-br from-[hsl(var(--penn-cyan)/0.18)] via-[hsl(var(--penn-navy)/0.12)] to-[hsl(var(--penn-gold)/0.22)] blur-md"
                  aria-hidden="true"
                />
                <img
                  src={pennLogo}
                  alt="PennPaps"
                  className="relative h-12 md:h-14 w-auto rounded-md ring-1 ring-[hsl(var(--penn-cyan)/0.18)]"
                />
              </div>
              <div className="hidden sm:flex flex-col leading-tight border-l border-border/60 pl-3">
                <span className="font-semibold tracking-tight text-base text-primary">
                  PennPaps
                  <span className="text-muted-foreground/70 font-normal">
                    .com
                  </span>
                </span>
                <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                  by Penn Home Medical Supply
                </span>
              </div>
            </Link>

            {/*
              Desktop nav. We bumped from text-sm/gap-6 to
              text-[15px]/gap-7 with a heavier hover treatment so
              the labels are easy to read for older patients (a
              significant share of CPAP users). The active route
              gets an underlined gold accent that doubles as a
              "you are here" landmark — important when the same
              header is reused on every page.
            */}
            <nav className="hidden md:flex items-center gap-7 text-[15px] font-medium">
              {navLinks.map((l) => {
                // Treat "/foo" as active for "/foo" and any
                // descendant route ("/foo/bar"). Home ("/") is
                // not in navLinks, so no special-case needed.
                const isActive =
                  location === l.href || location.startsWith(`${l.href}/`);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    aria-current={isActive ? "page" : undefined}
                    data-testid={`nav-${l.href.replace(/\//g, "")}`}
                    className={`relative py-1 transition-colors hover:text-primary focus-visible:text-primary ${
                      isActive
                        ? "text-primary after:absolute after:left-0 after:right-0 after:-bottom-1 after:h-[2px] after:rounded-full after:bg-gradient-to-r after:from-[hsl(var(--penn-cyan))] after:via-[hsl(var(--penn-gold))] after:to-[hsl(var(--penn-cyan))]"
                        : "text-foreground/75"
                    }`}
                  >
                    {l.label}
                  </Link>
                );
              })}
              <YourOrdersNavLink />
              <WishlistNavLink />
              <MiniCart />
              <UserMenu />
            </nav>

            {/* Mobile actions: cart icon + hamburger */}
            <div className="md:hidden flex items-center gap-2">
              <UserMenu />
              <WishlistNavLink />
              <MiniCart />
              <button
                type="button"
                onClick={() => setMobileOpen((v) => !v)}
                className="inline-flex items-center justify-center h-10 w-10 rounded-lg glass-panel border-0 text-primary hover:opacity-80 transition-opacity"
                aria-label={
                  mobileOpen ? "Close navigation menu" : "Open navigation menu"
                }
                aria-expanded={mobileOpen}
                aria-controls="mobile-nav-panel"
                data-testid="button-mobile-menu"
              >
                {mobileOpen ? (
                  <X className="h-5 w-5" />
                ) : (
                  <Menu className="h-5 w-5" />
                )}
              </button>
            </div>
          </div>

          {/*
            Mobile dropdown panel. Each row is now a 48px-tall
            target with base-size text — comfortably above the
            44px Apple HIG / 48dp Material minimums and easy to
            tap accurately for users with reduced dexterity. The
            active route gets a navy left rail + gold dot so the
            user always knows where they are inside the menu.
          */}
          {mobileOpen && (
            <div
              id="mobile-nav-panel"
              className="md:hidden border-t border-border/40 bg-white/90 backdrop-blur-md"
            >
              <nav className="container mx-auto flex flex-col px-3 py-3 gap-1 text-base font-medium">
                {navLinks.map((l) => {
                  const isActive =
                    location === l.href || location.startsWith(`${l.href}/`);
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`flex items-center justify-between min-h-12 px-4 rounded-xl transition-colors ${
                        isActive
                          ? "bg-secondary text-primary border-l-4 border-[hsl(var(--penn-gold))] pl-3"
                          : "text-foreground hover:bg-muted/60 active:bg-muted"
                      }`}
                      data-testid={`mobile-link-${l.href.replace("/", "")}`}
                    >
                      <span>{l.label}</span>
                      {isActive ? (
                        <span
                          aria-hidden
                          className="h-2 w-2 rounded-full bg-[hsl(var(--penn-gold))]"
                        />
                      ) : null}
                    </Link>
                  );
                })}
              </nav>
            </div>
          )}
        </div>
        <div className="aurora-divider-live" aria-hidden="true" />
      </header>

      {/*
       * Mask-fit progress indicator. Self-gates: returns null on
       * any non-fit-flow route, so we can mount it unconditionally
       * here without polluting unrelated pages (Shop, FAQ, etc).
       */}
      <FitFlowStepper />

      <main
        id="main-content"
        tabIndex={-1}
        /*
         * `tabIndex={-1}` lets the skip-link move focus into the main
         * landmark. We hide the *default* focus outline (which would also
         * show on programmatic focus from things like ScrollToTop) but
         * keep an explicit focus-visible ring so keyboard users actually
         * see where focus landed when they activate the skip link.
         */
        className="flex-1 flex flex-col relative focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background pb-20 md:pb-0"
      >
        {children}
      </main>

      <footer
        // On mobile two fixed-position elements occlude the footer:
        //   * MobileCtaBar — `fixed bottom-0`, ~60px tall.
        //   * FloatingContactLauncher button — `fixed bottom-20` (80px)
        //     with `h-14` (56px), top edge at 136px from viewport
        //     bottom. The button is `right-4` so it only covers the
        //     right strip, but the footer's "Staff sign-in" link sits
        //     on the right of a `flex-row justify-between` row
        //     (col-stacked on mobile but still right-aligned in its
        //     parent), so it sits in the FCL zone.
        // Padding therefore must clear the FCL top edge (136px) PLUS
        // the iOS home-indicator safe-area inset (up to ~34px on
        // home-indicator devices). 9rem (144px) + env(safe-area-...)
        // gives a 144–178px range — clears the FCL with ~8px margin
        // on every device. Desktop unaffected (both fixed elements
        // hide at `md:`).
        className="relative mt-12 pb-[calc(9rem+env(safe-area-inset-bottom))] md:pb-0"
      >
        <div className="aurora-divider-live" aria-hidden="true" />
        <div className="glass-panel border-x-0 border-b-0">
          <div className="container mx-auto px-4 md:px-6 py-6">
            {/* Top: brand + condensed link columns */}
            <div className="grid grid-cols-2 md:grid-cols-12 gap-x-6 gap-y-5">
              {/* Brand block */}
              <div className="col-span-2 md:col-span-4 flex items-center gap-3">
                <img
                  src={pennLogo}
                  alt="Penn Home Medical Supply"
                  className="h-9 w-auto rounded-md"
                />
                <div className="leading-tight">
                  <div className="font-semibold tracking-tight text-foreground text-sm">
                    Penn Home Medical Supply
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    PennPaps.com — Fit · Shop · Resupply
                  </div>
                </div>
              </div>

              {/* Patient services */}
              <div className="md:col-span-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 font-semibold">
                  Patient Services
                </div>
                <ul className="space-y-1 text-sm">
                  <li>
                    <Link
                      href="/how-it-works"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Virtual Mask Fitter
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/shop"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Shop Supplies
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/account"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      My Account
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/returns"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Returns &amp; refunds
                    </Link>
                  </li>
                </ul>
              </div>

              {/* Contact */}
              <div className="md:col-span-2">
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 font-semibold">
                  Talk to us
                </div>
                <ul className="space-y-1 text-sm">
                  <li>
                    <a
                      href={`tel:${SUPPORT_PHONE_E164}`}
                      className="text-muted-foreground hover:text-primary transition-colors"
                      data-testid="footer-support-phone"
                    >
                      {SUPPORT_PHONE_DISPLAY}
                    </a>
                  </li>
                  <li>
                    <a
                      href={`mailto:${SUPPORT_EMAIL}`}
                      className="text-muted-foreground hover:text-primary transition-colors break-all"
                      data-testid="footer-support-email"
                    >
                      {SUPPORT_EMAIL}
                    </a>
                  </li>
                  <li className="text-xs text-muted-foreground/80">
                    {SUPPORT_HOURS}
                  </li>
                </ul>
              </div>

              {/* Legal */}
              <div className="md:col-span-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 font-semibold">
                  Legal &amp; Privacy
                </div>
                <ul className="space-y-1 text-sm">
                  <li>
                    <Link
                      href="/privacy"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Privacy Policy
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/terms"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Terms of Service
                    </Link>
                  </li>
                  {/*
                    /consent is the in-flow data-use consent screen for camera /
                    biometric processing, distinct from the Terms of Service.
                  */}
                  <li>
                    <Link
                      href="/consent"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Data Use &amp; Consent
                    </Link>
                  </li>
                </ul>
              </div>
            </div>

            {/* Bottom bar: copyright + staff sign-in (combined to save vertical space) */}
            <div className="mt-5 pt-4 border-t border-border/40 flex flex-col md:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
              <div>
                © {new Date().getFullYear()} Penn Home Medical Supply. Licensed
                DME provider.
              </div>
              <Link
                href="/admin/sign-in"
                className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80 hover:text-[hsl(var(--penn-navy))] transition-colors"
                data-testid="footer-staff-signin"
              >
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                Staff sign-in
              </Link>
            </div>
          </div>
        </div>
      </footer>
      <FloatingContactLauncher />
      <MobileCtaBar />
      <KeyboardShortcutsDialog />
    </div>
  );
}
