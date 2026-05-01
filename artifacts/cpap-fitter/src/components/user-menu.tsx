// UserMenu — header chrome for the patient experience.
//
//   Signed in  → an avatar pill with a dropdown linking to /account
//                + sign-out.
//   Signed out → "Sign in" link that round-trips back to the current
//                path via ?redirect=, so a visitor who clicks "Sign in"
//                from /shop/cart lands back on /shop/cart afterwards
//                instead of the admin dashboard.
//
// In Clerk mode the dropdown previously used Clerk's hosted
// <UserButton/>. Stage 4b replaces it with a vendor-agnostic
// implementation that calls the identity shim's signOut() — same
// UX for the customer, but works equally well when ClerkProvider
// is absent (in_house mode).

import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { LogIn, LogOut, User } from "lucide-react";

import { SignedIn, useShopIdentity } from "@/lib/identity";

export function UserMenu() {
  const [location] = useLocation();

  // Build the round-trip URL once so both branches use the same
  // target. Avoid sending the user back to /sign-in or /sign-up
  // themselves (would loop after auth) — fall back to /account in
  // those cases.
  const safeRedirect =
    location.startsWith("/sign-in") || location.startsWith("/sign-up")
      ? "/account"
      : location;
  const signInHref = `/sign-in?redirect=${encodeURIComponent(safeRedirect)}`;

  return (
    <SignedIn
      fallback={
        <Link
          href={signInHref}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
          data-testid="nav-sign-in"
        >
          <LogIn className="h-4 w-4" /> Sign in
        </Link>
      }
    >
      <UserPill />
    </SignedIn>
  );
}

function initialFor(email: string | null, displayName: string | null): string {
  if (displayName && displayName.trim().length > 0) {
    return displayName.trim()[0]!.toUpperCase();
  }
  if (email && email.length > 0) return email[0]!.toUpperCase();
  return "?";
}

function UserPill() {
  const { email, displayName, signOut } = useShopIdentity();
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close the menu when the user clicks anywhere else on the page.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-9 w-9 rounded-full bg-[hsl(var(--penn-navy)/0.10)] text-[hsl(var(--penn-navy))] font-semibold text-sm flex items-center justify-center hover:bg-[hsl(var(--penn-navy)/0.18)] transition-colors"
        data-testid="user-menu-button"
        title={email ?? "Account"}
      >
        {initialFor(email, displayName)}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 rounded-lg border bg-background shadow-md p-1 text-sm z-50"
        >
          {email && (
            <div className="px-3 py-2 border-b text-xs text-muted-foreground truncate">
              {email}
            </div>
          )}
          <Link
            href="/account"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted"
            role="menuitem"
          >
            <User className="h-4 w-4" /> My account
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut().finally(() => {
                setLocation("/");
              });
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted text-left"
            data-testid="user-menu-sign-out"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
