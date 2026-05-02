import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ShieldCheck, Menu, X, Package, Heart } from "lucide-react";
import pennLogo from "@assets/IMG_2053_1777233708393.jpeg";
import { SignedIn } from "@/lib/identity";
import { UserMenu } from "@/components/user-menu";
import { FitFlowStepper } from "@/components/fit-flow-stepper";
import { PwaInstallPrompt } from "@/components/pwa-install-prompt";
import { MobileCtaBar } from "@/components/mobile-cta-bar";
import { MiniCart } from "@/components/shop/mini-cart";
import { useWishlist } from "@/lib/wishlist";

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
            <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
              <div className="relative">
                <div className="absolute -inset-1 rounded-xl bg-gradient-to-br from-[hsl(var(--penn-navy)/0.10)] to-[hsl(var(--penn-gold)/0.20)] blur-md" aria-hidden="true" />
                <img
                  src={pennLogo}
                  alt="PennPaps"
                  className="relative h-12 md:h-14 w-auto rounded-md"
                />
              </div>
              <div className="hidden sm:flex flex-col leading-tight border-l border-border/60 pl-3">
                <span className="font-semibold tracking-tight text-base text-primary">PennPaps<span className="text-muted-foreground/70 font-normal">.com</span></span>
                <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">by Penn Home Medical Supply</span>
              </div>
            </Link>

            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
              {navLinks.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="text-muted-foreground transition-colors hover:text-primary"
                >
                  {l.label}
                </Link>
              ))}
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
                aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
                aria-expanded={mobileOpen}
                aria-controls="mobile-nav-panel"
                data-testid="button-mobile-menu"
              >
                {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {/* Mobile dropdown panel */}
          {mobileOpen && (
            <div
              id="mobile-nav-panel"
              className="md:hidden border-t border-border/40 bg-white/85 backdrop-blur-md"
            >
              <nav className="container mx-auto flex flex-col px-4 py-3 gap-1 text-sm font-medium">
                {navLinks.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="block px-3 py-2.5 rounded-lg text-foreground hover:bg-muted/60 transition-colors"
                    data-testid={`mobile-link-${l.href.replace("/", "")}`}
                  >
                    {l.label}
                  </Link>
                ))}
              </nav>
            </div>
          )}
        </div>
        <div className="aurora-divider" aria-hidden="true" />
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

      <footer className="relative mt-16">
        <div className="aurora-divider" aria-hidden="true" />
        <div className="glass-panel border-x-0 border-b-0">
          <div className="container mx-auto px-4 md:px-6 py-10 md:py-12">
            {/* Top: brand block + link columns */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-10">
              {/* Brand block */}
              <div className="md:col-span-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="relative">
                    <div className="absolute -inset-1 rounded-xl bg-gradient-to-br from-[hsl(var(--penn-navy)/0.10)] to-[hsl(var(--penn-gold)/0.20)] blur-md" aria-hidden="true" />
                    <img
                      src={pennLogo}
                      alt="Penn Home Medical Supply"
                      className="relative h-11 w-auto rounded-md"
                    />
                  </div>
                  <div className="leading-tight">
                    <div className="font-semibold tracking-tight text-foreground">
                      Penn Home Medical Supply
                    </div>
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      PennPaps.com — Mask Fitting · Shop · Resupply
                    </div>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
                  <span className="font-semibold text-foreground">PennPaps.com</span> is the
                  online CPAP storefront from{" "}
                  <span className="font-semibold text-foreground">Penn Home Medical Supply</span>{" "}
                  — fit a new mask, order supplies direct, and stay on a
                  resupply schedule with your local DME team.
                </p>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-border/60 bg-white/40 px-3 py-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                  <span>Secure checkout · private on-device fitting.</span>
                </div>
              </div>

              {/* Patient services */}
              <div className="md:col-span-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3 font-semibold">
                  Patient Services
                </div>
                <ul className="space-y-2 text-sm">
                  <li><Link href="/how-it-works" className="text-muted-foreground hover:text-primary transition-colors">Virtual Mask Fitter</Link></li>
                  <li><Link href="/masks" className="text-muted-foreground hover:text-primary transition-colors">Mask Catalog</Link></li>
                  <li><Link href="/shop" className="text-muted-foreground hover:text-primary transition-colors">Shop Supplies</Link></li>
                  <li><Link href="/shop/wishlist" className="text-muted-foreground hover:text-primary transition-colors">Saved for later</Link></li>
                  <li><Link href="/insurance" className="text-muted-foreground hover:text-primary transition-colors">How insurance works</Link></li>
                  <li><Link href="/account" className="text-muted-foreground hover:text-primary transition-colors">My Account</Link></li>
                  <li><Link href="/learn" className="text-muted-foreground hover:text-primary transition-colors">Learn</Link></li>
                  <li><Link href="/faq" className="text-muted-foreground hover:text-primary transition-colors">FAQ</Link></li>
                </ul>
              </div>

              {/* Legal */}
              <div className="md:col-span-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3 font-semibold">
                  Legal & Privacy
                </div>
                <ul className="space-y-2 text-sm">
                  <li><Link href="/privacy" className="text-muted-foreground hover:text-primary transition-colors">Privacy Policy</Link></li>
                  <li><Link href="/terms" className="text-muted-foreground hover:text-primary transition-colors">Terms of Service</Link></li>
                  {/*
                    /consent is the in-flow data-use consent screen for camera /
                    biometric processing, distinct from the Terms of Service.
                  */}
                  <li><Link href="/consent" className="text-muted-foreground hover:text-primary transition-colors">Data Use & Consent</Link></li>
                </ul>
              </div>
            </div>

            {/* Bottom bar: copyright + parent-company callout */}
            <div className="mt-10 pt-6 border-t border-border/40 flex flex-col md:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
              <div>
                © {new Date().getFullYear()} Penn Home Medical Supply. All rights reserved.
              </div>
              <div className="text-center md:text-right">
                Penn Home Medical Supply is a licensed durable medical equipment provider.
                {" "}PennPaps.com is its online patient-facing service.
              </div>
            </div>
          </div>
        </div>
      </footer>
      <PwaInstallPrompt />
      <MobileCtaBar />
    </div>
  );
}
