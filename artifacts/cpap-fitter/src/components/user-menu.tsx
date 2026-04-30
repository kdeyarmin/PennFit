// UserMenu — header chrome for the patient experience.
//
//   Signed in  → Clerk's <UserButton/> avatar with a custom dropdown
//                action linking to /account.
//   Signed out → "Sign in" link that round-trips back to the current
//                path via ?redirect=, so a visitor who clicks "Sign in"
//                from /shop/cart lands back on /shop/cart afterwards
//                instead of the admin dashboard.
//
// The admin sign-in path keeps using its existing forceRedirectUrl
// (set by the AdminShell entry point), so this hook only changes the
// patient experience. See pages/sign-in.tsx for the redirect-honoring
// logic.

import { Link, useLocation } from "wouter";
import { Show, UserButton } from "@clerk/react";
import { LogIn, User } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function UserMenu() {
  const [location] = useLocation();

  // Build the round-trip URL once so both branches use the same target.
  // Avoid sending the user back to /sign-in or /sign-up themselves
  // (would loop after auth) — fall back to /account in those cases.
  const safeRedirect =
    location.startsWith("/sign-in") || location.startsWith("/sign-up")
      ? "/account"
      : location;
  const signInHref = `/sign-in?redirect=${encodeURIComponent(safeRedirect)}`;

  // the auth provider v6 uses <Show when="signed-in" /> instead of the older
  // <SignedIn>/<SignedOut> components. The fallback prop renders for
  // signed-out (and during the brief loading window — `Show` returns
  // null until the auth provider loads, which keeps the header from flashing).
  return (
    <Show
      when="signed-in"
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
      <UserButton
        userProfileMode="navigation"
        userProfileUrl={`${basePath}/account`}
        appearance={{
          elements: {
            userButtonAvatarBox: "h-9 w-9",
          },
        }}
      >
        <UserButton.MenuItems>
          <UserButton.Link
            label="My account"
            labelIcon={<User className="h-4 w-4" />}
            href={`${basePath}/account`}
          />
        </UserButton.MenuItems>
      </UserButton>
    </Show>
  );
}
