import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ShieldCheck, Menu, X } from "lucide-react";
import {
  PLATFORM_LOGO_URL,
  hasDistinctStorefrontName,
  useStorefrontBranding,
} from "@/lib/branding";
import { UserMenu } from "@/components/user-menu";
import { FitFlowStepper } from "@/components/fit-flow-stepper";
import { MobileCtaBar } from "@/components/mobile-cta-bar";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { FloatingContactLauncher } from "@/components/floating-contact-launcher";
import { useCompanyContact } from "@/lib/contact";

// Reset scroll to the top on every route change. Without this, navigating
// from a long page (e.g. Results) into a new page leaves the user halfway
// down the document — they often miss the new page's hero entirely.
function ScrollToTop() {
  const [location] = useLocation();
  // Skip the focus reset on the very first render: stealing focus on
  // initial page load would override the browser's default (and break
  // e.g. autofocus on a deep-linked form). Only client-side navigations
  // need the reset.
  const isFirstRender = useRef(true);
  useEffect(() => {
    // Use "auto" (instant) — animated scroll on route change is jarring
    // and can race with route-mount animations.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // Move focus into the new page's <main> landmark so screen-reader and
    // keyboard users start at the new content instead of being stranded on
    // the previous page's (now-stale) focus position. The landmark already
    // has tabIndex={-1} for the skip link, and its outline is
    // focus-visible-only, so pointer users see no change.
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [location]);
  return null;
}

// Primary header navigation — flat, task-oriented links so new patients
// can scan the bar and jump straight to what they need. Brand mask pages,
// the article library, and FAQ live in the footer and /help hub instead of
// a nested dropdown.
type NavLink = { href: string; label: string };

const navLinks: NavLink[] = [
  { href: "/how-it-works", label: "Get fitted" },
  { href: "/insurance", label: "Order" },
  { href: "/masks", label: "Masks" },
  { href: "/track-order", label: "Track" },
  { href: "/help", label: "Help" },
];

// A nav route is "active" for its own path and any descendant
// ("/foo" matches "/foo" and "/foo/bar"). Shared by the desktop
// dropdown, the desktop flat links, and the mobile panel.
function isHrefActive(location: string, href: string): boolean {
  return location === href || location.startsWith(`${href}/`);
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
  const contact = useCompanyContact();
  const branding = useStorefrontBranding();
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
              <img
                src={branding.logoUrl ?? PLATFORM_LOGO_URL}
                alt={branding.storefrontName}
                // Intrinsic dimensions of the platform logo (518×481) so the
                // browser reserves the right aspect ratio and the sticky
                // header doesn't shift on first paint (CLS). Only applied to
                // the default logo — a tenant's uploaded logo has its own
                // aspect ratio, so we let the browser size it naturally. CSS
                // still drives the rendered height via h-12/h-14 + w-auto.
                width={branding.logoUrl ? undefined : 518}
                height={branding.logoUrl ? undefined : 481}
                className="h-12 md:h-14 w-auto"
              />
              <div className="hidden sm:flex flex-col leading-tight border-l border-border/60 pl-3">
                <span className="font-semibold tracking-tight text-base text-primary">
                  {branding.storefrontName}
                </span>
                {hasDistinctStorefrontName(branding) && (
                  <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                    by {branding.legalName}
                  </span>
                )}
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
                const isActive = isHrefActive(location, l.href);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    aria-current={isActive ? "page" : undefined}
                    data-testid={`nav-${l.href.replace(/\//g, "")}`}
                    className={`relative py-1 transition-colors hover:text-primary focus-visible:text-primary ${
                      isActive
                        ? "text-primary after:absolute after:left-0 after:right-0 after:-bottom-1 after:h-[2px] after:rounded-full after:bg-[hsl(var(--penn-gold))]"
                        : "text-foreground/75"
                    }`}
                  >
                    {l.label}
                  </Link>
                );
              })}
              <UserMenu />
            </nav>

            {/* Mobile actions: hamburger */}
            <div className="md:hidden flex items-center gap-2">
              <UserMenu />
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
                  const isActive = isHrefActive(location, l.href);
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
                      data-testid={`mobile-link-${l.href.replace(/\//g, "")}`}
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
              <div className="col-span-2 md:col-span-3 flex items-center gap-3">
                <img
                  src={branding.logoUrl ?? PLATFORM_LOGO_URL}
                  alt={branding.legalName}
                  width={branding.logoUrl ? undefined : 518}
                  height={branding.logoUrl ? undefined : 481}
                  className="h-9 w-auto rounded-md"
                />
                <div className="leading-tight">
                  <div className="font-semibold tracking-tight text-foreground text-sm">
                    {branding.legalName}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {hasDistinctStorefrontName(branding)
                      ? `${branding.storefrontName} — Fit · Order · Resupply`
                      : "Fit · Order · Resupply"}
                  </div>
                </div>
              </div>

              {/* Patient services */}
              <div className="md:col-span-2">
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
                      href="/masks"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Mask catalog
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/insurance"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Order through insurance
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/insurance/estimate"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Insurance estimate
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
                      href="/track-order"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Track an order
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/reminders"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Resupply reminders
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/help"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Help Center
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/faq"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      FAQ
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/contact"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Contact us
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/comfort-guarantee"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Comfort guarantee
                    </Link>
                  </li>
                </ul>
              </div>

              {/* Learn — surface the long-form education library and
                  brand pages from every page of the site. Compact list
                  (5 items) so the footer doesn't bloat; the full
                  library lives on /learn. */}
              <div className="md:col-span-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2 font-semibold">
                  Learn &amp; Resources
                </div>
                <ul className="space-y-1 text-sm">
                  <li>
                    <Link
                      href="/sleep-apnea-101"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Sleep apnea 101
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/learn"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Article library
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/learn/glossary"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      CPAP glossary
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/cpap-masks"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Mask brands
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/cpap-masks/resmed"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      ResMed masks
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/cpap-masks/react-health"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      React Health masks
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/cpap-masks/fisher-paykel"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Fisher &amp; Paykel masks
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/stories"
                      className="text-muted-foreground hover:text-primary"
                    >
                      Patient stories
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/learn/sleep-apnea-quiz"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      Self-screener
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
                  {contact.phoneE164 && (
                    <li>
                      <a
                        href={`tel:${contact.phoneE164}`}
                        className="text-muted-foreground hover:text-primary transition-colors"
                        data-testid="footer-support-phone"
                      >
                        {contact.phoneDisplay}
                      </a>
                    </li>
                  )}
                  <li>
                    <a
                      href={`mailto:${contact.email}`}
                      className="text-muted-foreground hover:text-primary transition-colors break-all"
                      data-testid="footer-support-email"
                    >
                      {contact.email}
                    </a>
                  </li>
                  <li className="text-xs text-muted-foreground/80">
                    {contact.hours}
                  </li>
                </ul>
              </div>

              {/* Legal */}
              <div className="md:col-span-2">
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
                    Camera / biometric data-use lives on the Privacy Policy.
                    /consent is the fitter lead-capture gate — keep it off
                    the Legal footer so a legal-nav click does not start
                    the mask fitting flow.
                  */}
                  <li>
                    <Link
                      href="/privacy"
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
                © {new Date().getFullYear()} {branding.legalName}. Licensed DME
                provider.
              </div>
              {/*
                Staff sign-in is the ONLY route into the admin console from a
                tenant storefront, so it gets a bordered pill rather than the
                near-invisible 11px caps it used to wear — staff kept failing
                to find it. Still visually quieter than any patient-facing
                CTA, which is the right hierarchy for a footer link most
                visitors should ignore.
              */}
              <Link
                href="/admin/sign-in"
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:border-[hsl(var(--penn-navy))] hover:text-[hsl(var(--penn-navy))] transition-colors"
                data-testid="footer-staff-signin"
              >
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
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
