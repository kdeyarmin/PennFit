import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ShieldCheck, Menu, X, ShoppingCart } from "lucide-react";
import pennLogo from "@assets/IMG_2053_1777233708393.jpeg";
import { useCart } from "@/hooks/use-cart";
import { UserMenu } from "@/components/user-menu";

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

// CartNavIcon — small cart link with a count badge for the header.
// Lives in this file because it's a layout concern (header chrome) and
// the only consumer is the Layout itself; extracting to its own file
// would just be indirection for a 20-line component.
function CartNavIcon() {
  const { count } = useCart();
  const hasItems = count > 0;
  return (
    <Link
      href="/shop/cart"
      className={`relative inline-flex items-center justify-center h-10 w-10 rounded-lg transition-colors ${
        hasItems
          ? "text-[hsl(var(--penn-navy))] hover:bg-secondary/40"
          : "text-muted-foreground hover:text-primary hover:bg-secondary/40"
      }`}
      aria-label={`Cart (${count} item${count === 1 ? "" : "s"})`}
      data-testid="nav-cart-icon"
    >
      <ShoppingCart className="h-5 w-5" strokeWidth={hasItems ? 2.25 : 2} />
      {hasItems && (
        <span
          // Floating gold pill: ring-2 ring-white separates it from the cart
          // icon edge so the count never visually fuses with the cart strokes.
          // tabular-nums keeps "12" the same width as "11" so the pill doesn't
          // jiggle as the count changes.
          className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1.5 rounded-full bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))] text-[11px] font-bold leading-none flex items-center justify-center tabular-nums ring-2 ring-white shadow-sm"
          data-testid="nav-cart-count"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
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
      <header className="sticky top-0 z-50 w-full">
        <div className="glass-panel border-x-0 border-t-0 border-b border-border/40">
          <div className="container mx-auto flex h-20 items-center justify-between px-4 md:px-6">
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
              <CartNavIcon />
              <UserMenu />
            </nav>

            {/* Mobile actions: cart icon + hamburger */}
            <div className="md:hidden flex items-center gap-2">
              <UserMenu />
              <CartNavIcon />
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

      <main className="flex-1 flex flex-col relative">{children}</main>

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
                  <li><Link href="/consent" className="text-muted-foreground hover:text-primary transition-colors">Order with Insurance</Link></li>
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
    </div>
  );
}
