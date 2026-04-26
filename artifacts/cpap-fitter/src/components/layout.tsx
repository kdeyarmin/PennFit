import React from "react";
import { Link } from "wouter";
import { Activity, ShieldCheck } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Activity className="h-5 w-5" />
            </div>
            <span className="font-semibold tracking-tight text-lg">AeroFit</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link href="/masks" className="text-muted-foreground transition-colors hover:text-primary">
              Mask Catalog
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 flex flex-col relative">{children}</main>
      <footer className="border-t border-border/40 bg-muted/20">
        <div className="container mx-auto flex flex-col md:flex-row items-center justify-between gap-4 py-6 px-4 md:px-6 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            <span>Secure & Private. Images never leave your device.</span>
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
