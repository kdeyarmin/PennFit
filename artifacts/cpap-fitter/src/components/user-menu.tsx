// UserMenu — header chrome for the patient experience.
//
//   Signed in  → an avatar pill with a dropdown linking to /account
//                + sign-out.
//   Signed out → "Sign in" link that round-trips back to the current
//                path via ?redirect=, so a visitor who clicks "Sign in"
//                from /shop/cart lands back on /shop/cart afterwards
//                instead of the admin dashboard.
//
// The dropdown calls the identity shim's signOut() which clears the
// in-house pf_session cookie and resets the React Query cache.

import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { LogIn, LogOut, MessageSquare, User } from "lucide-react";

import { SignedIn, useShopIdentity } from "@/lib/identity";
import { useShopMessagesUnread } from "@/hooks/use-shop-messages-unread";

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
  const unreadCsr = useShopMessagesUnread();

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
        // Compose a screen-reader label that always conveys both the
        // account context AND the unread count, so a screen reader user
        // doesn't depend on the visual dot.
        aria-label={
          unreadCsr > 0
            ? `Account menu — ${unreadCsr} new message${unreadCsr === 1 ? "" : "s"} from PennPaps`
            : "Account menu"
        }
        className="relative h-9 w-9 rounded-full bg-[hsl(var(--penn-navy)/0.10)] text-[hsl(var(--penn-navy))] font-semibold text-sm flex items-center justify-center hover:bg-[hsl(var(--penn-navy)/0.18)] transition-colors"
        data-testid="user-menu-button"
        title={email ?? "Account"}
      >
        {initialFor(email, displayName)}
        {unreadCsr > 0 && (
          <span
            // Small red dot in the top-right corner of the avatar.
            // Decorative — the count is in the menu row + aria-label.
            aria-hidden="true"
            data-testid="user-menu-unread-dot"
            className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-rose-600 ring-2 ring-background"
          />
        )}
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
          {unreadCsr > 0 && (
            <Link
              href="/account#messages"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-rose-50 text-rose-700"
              role="menuitem"
              data-testid="user-menu-unread-row"
            >
              <MessageSquare className="h-4 w-4" />
              {unreadCsr === 1
                ? "1 new message from PennPaps"
                : `${unreadCsr} new messages from PennPaps`}
            </Link>
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
