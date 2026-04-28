import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ShieldCheck, Menu, X } from "lucide-react";
import pennLogo from "@assets/IMG_2053_1777233708393.jpeg";

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
  { href: "/how-it-works", label: "How It Works" },
  { href: "/masks", label: "Mask Catalog" },
  { href: "/learn", label: "Learn" },
  { href: "/faq", label: "FAQ" },
];

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
                <span className="font-semibold tracking-tight text-base text-primary">PennPaps</span>
                <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">CPAP Mask Fitting</span>
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
            </nav>

            {/* Mobile hamburger */}
            <button
              type="button"
              onClick={() => setMobileOpen((v) => !v)}
              className="md:hidden inline-flex items-center justify-center h-10 w-10 rounded-lg glass-panel border-0 text-primary hover:opacity-80 transition-opacity"
              aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav-panel"
              data-testid="button-mobile-menu"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
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

      <footer className="relative mt-12">
        <div className="aurora-divider" aria-hidden="true" />
        <div className="glass-panel border-x-0 border-b-0">
          <div className="container mx-auto flex flex-col md:flex-row items-center justify-between gap-4 py-6 px-4 md:px-6 text-xs text-muted-foreground">
            <div className="flex flex-col md:flex-row items-center gap-2 md:gap-4">
              <span className="font-semibold tracking-tight text-foreground">PennPaps</span>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <span>Secure & private. Images never leave your device.</span>
              </div>
            </div>
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-2">
              <Link href="/learn" className="hover:text-primary transition-colors">Learn</Link>
              <Link href="/faq" className="hover:text-primary transition-colors">FAQ</Link>
              <Link href="/how-it-works" className="hover:text-primary transition-colors">How It Works</Link>
              <Link href="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
              {/*
                /consent is the in-flow data-use consent screen, NOT a Terms
                of Service. Mislabelling it as "Terms of Service" was a
                liability — relabel to match what the page actually is.
              */}
              <Link href="/consent" className="hover:text-primary transition-colors">Data Use & Consent</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
