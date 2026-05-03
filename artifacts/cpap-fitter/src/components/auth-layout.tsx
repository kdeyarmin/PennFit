// AuthLayout — chrome wrapper for the standalone authentication pages
// (sign-in, sign-up, forgot-password, reset-password, verify-email)
// for both the customer storefront and the admin console.
//
// Why this exists: the auth pages are intentionally rendered OUTSIDE
// the global <Layout> in App.tsx so they can present a centered,
// distraction-free card. The downside of that decision was that a
// visitor who landed on a sign-in page had no header, no logo, and
// no links — the page was a navigational dead end if they didn't
// have credentials. This shell adds a slim, low-distraction top bar
// (logo + escape link) and a small footer row so visitors can always
// get back to the public site or jump to help.

import type { ReactNode } from "react";
import { Link } from "wouter";
import { ArrowLeft, MessageCircle, ShieldCheck } from "lucide-react";

import pennLogo from "@assets/IMG_2053_1777233708393.jpeg";

interface Props {
  /**
   * Which surface this auth page belongs to.
   *
   *   "customer" — patient-facing pages under /sign-in, /sign-up, etc.
   *                Footer offers public-site links (Shop, Learn, FAQ).
   *   "admin"    — staff-facing pages under /admin/sign-in. The escape
   *                link points back to the public storefront so a
   *                customer who landed here by accident can leave.
   */
  variant: "customer" | "admin";
  children: ReactNode;
}

export function AuthLayout({ variant, children }: Props) {
  const isAdmin = variant === "admin";
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: isAdmin ? "#f7f8fb" : undefined }}
    >
      {/* Top bar: brand mark + escape link back to the public site. */}
      <header className="border-b border-border/50 bg-white/80 backdrop-blur">
        <div className="container mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 group"
            data-testid="auth-brand-link"
          >
            <img
              src={pennLogo}
              alt="Penn Home Medical Supply"
              className="h-9 w-auto rounded-md"
            />
            <span className="hidden sm:flex flex-col leading-tight">
              <span className="font-semibold text-sm text-[hsl(var(--penn-navy-deep))]">
                PennPaps<span className="text-muted-foreground">.com</span>
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                {isAdmin
                  ? "Staff sign-in"
                  : "Penn Home Medical Supply"}
              </span>
            </span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-muted-foreground hover:text-[hsl(var(--penn-navy))] transition-colors"
            data-testid="auth-back-home"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">
              {isAdmin ? "Back to PennPaps.com" : "Back to home"}
            </span>
            <span className="sm:hidden">Home</span>
          </Link>
        </div>
      </header>

      {/* Centered auth card slot. */}
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        {children}
      </main>

      {/*
        Footer escape row — small, muted, always visible. Customer
        variant offers the most common public destinations a visitor
        might want instead of signing in. Admin variant intentionally
        keeps it minimal so staff aren't distracted, but still gives
        them a route back to the storefront.
      */}
      <footer className="border-t border-border/50 bg-white/60">
        <div className="container mx-auto px-4 md:px-6 py-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {isAdmin ? (
            <>
              <Link href="/" className="hover:text-[hsl(var(--penn-navy))] transition-colors">
                PennPaps.com
              </Link>
              <span aria-hidden="true">·</span>
              <Link href="/faq" className="hover:text-[hsl(var(--penn-navy))] transition-colors">
                Patient FAQ
              </Link>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                Authorised staff only
              </span>
            </>
          ) : (
            <>
              <Link href="/" className="hover:text-[hsl(var(--penn-navy))] transition-colors">
                Home
              </Link>
              <span aria-hidden="true">·</span>
              <Link href="/shop" className="hover:text-[hsl(var(--penn-navy))] transition-colors">
                Shop
              </Link>
              <span aria-hidden="true">·</span>
              <Link href="/learn" className="hover:text-[hsl(var(--penn-navy))] transition-colors">
                Learn
              </Link>
              <span aria-hidden="true">·</span>
              <Link href="/faq" className="hover:text-[hsl(var(--penn-navy))] transition-colors">
                FAQ
              </Link>
              <span aria-hidden="true">·</span>
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-1 hover:text-[hsl(var(--penn-navy))] transition-colors"
              >
                <MessageCircle className="h-3 w-3" aria-hidden="true" />
                Talk to us
              </Link>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
