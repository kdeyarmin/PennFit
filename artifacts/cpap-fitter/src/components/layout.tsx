import React from "react";
import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";
import pennLogo from "@assets/IMG_2053_1777233708393.jpeg";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-20 items-center justify-between px-4 md:px-6">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
            <img
              src={pennLogo}
              alt="Penn Home Medical Supply"
              className="h-12 md:h-14 w-auto"
            />
            <div className="hidden sm:flex flex-col leading-tight border-l border-border/60 pl-3">
              <span className="font-semibold tracking-tight text-base text-primary">Penn Fit</span>
              <span className="text-xs text-muted-foreground">CPAP Mask Fitting</span>
            </div>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link href="/how-it-works" className="text-muted-foreground transition-colors hover:text-primary">
              How It Works
            </Link>
            <Link href="/masks" className="text-muted-foreground transition-colors hover:text-primary">
              Mask Catalog
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 flex flex-col relative">{children}</main>
      <footer className="border-t border-border/40 bg-muted/20">
        <div className="container mx-auto flex flex-col md:flex-row items-center justify-between gap-4 py-6 px-4 md:px-6 text-xs text-muted-foreground">
          <div className="flex flex-col md:flex-row items-center gap-2 md:gap-4">
            <span className="font-medium text-foreground">Penn Home Medical Supply, LLC</span>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              <span>Secure & Private. Images never leave your device.</span>
            </div>
          </div>
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
            <Link href="/consent" className="hover:text-primary transition-colors">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
