// Identity shim for cpap-fitter — picks Clerk vs in-house at
// module-load time so the rest of the app stays auth-vendor-
// agnostic.
//
// Pick rule:
//   VITE_AUTH_PROVIDER === "in_house" → in-house implementation
//   anything else (including unset)    → Clerk implementation
//
// Both branch files are imported (Vite ships either implementation
// in its respective build), but only one is invoked at runtime via
// the module-load-time constant. This preserves the rules-of-hooks
// invariant for every consumer.
//
// What the shim returns:
//   {
//     email:        primary email or null when signed-out
//     userId:       Clerk user id OR auth.users.id depending on mode
//     displayName:  optional display name
//     isSignedIn:   true when the SPA has identified the visitor
//     isLoaded:     true when the relevant probe has settled
//                   (Clerk's session check, or /auth/me round-trip)
//     signOut:      kicks off sign-out + cleanup. Always returns a
//                   Promise so `await` is consistent across modes.
//   }
//
// Components and hooks that previously called Clerk's `useUser` /
// `useClerk` should import `useShopIdentity()` from here instead.

import * as clerkImpl from "./identity-clerk";
import * as inHouseImpl from "./identity-in-house";

const provider = (import.meta.env.VITE_AUTH_PROVIDER ?? "clerk") as
  | "clerk"
  | "dual"
  | "in_house";

export interface ShopIdentity {
  email: string | null;
  userId: string | null;
  displayName: string | null;
  isSignedIn: boolean;
  isLoaded: boolean;
  signOut: () => Promise<void>;
}

/**
 * Read the current shop identity. In Clerk mode this wraps
 * `useUser()` / `useClerk()`; in in-house mode it wraps
 * `useSession()`.
 */
export const useShopIdentity: () => ShopIdentity =
  provider === "in_house"
    ? inHouseImpl.useShopIdentity
    : clerkImpl.useShopIdentity;

/** True when the SPA is configured to use the in-house auth path. */
export const IS_IN_HOUSE_AUTH = provider === "in_house";

/**
 * Wraps `<Show when="signed-in">` (Clerk) and an in-house
 * equivalent. Both implementations render `children` only when
 * `isSignedIn` is true. The Clerk impl preserves the legacy
 * Clerk-boot fallback semantics; the in-house impl falls back to
 * `null` while /auth/me is in flight.
 */
export const SignedIn: React.FC<{
  children: React.ReactNode;
  fallback?: React.ReactNode;
}> = provider === "in_house" ? inHouseImpl.SignedIn : clerkImpl.SignedIn;

/** Inverse of <SignedIn>. */
export const SignedOut: React.FC<{
  children: React.ReactNode;
}> = provider === "in_house" ? inHouseImpl.SignedOut : clerkImpl.SignedOut;
