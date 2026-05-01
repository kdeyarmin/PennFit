// Dashboard identity shim — picks Clerk or the in-house auth at
// module-load time so the rest of the dashboard can stay
// auth-vendor-agnostic.
//
// Pick rule:
//   VITE_AUTH_PROVIDER === "in_house" → in-house implementation
//   anything else (including unset)    → Clerk implementation
//
// At module load only ONE branch is evaluated for hook selection,
// so the rules-of-hooks invariant is preserved for every consumer.
// Both branch files are still imported (so Vite ships either
// implementation), but only one runs.
//
// What the shim returns:
//   {
//     email:        the verified primary email, or null if signed-out
//     role:         "admin" | "agent" | "customer" | null
//     displayName:  optional display name (in-house only; Clerk impl
//                   returns null because Clerk doesn't expose a
//                   stable display name we already use)
//     userId:       the auth-provider-specific user id (Clerk id or
//                   in-house auth.users.id)
//     signOut:      kicks off sign-out + cookie/session cleanup.
//                   ALWAYS returns a Promise even when the underlying
//                   provider is fire-and-forget so callers can
//                   `await` consistently.
//   }
//
// Components that previously called `useUser()` / `useClerk()`
// import from this file instead.

import * as clerkImpl from "./identity-clerk";
import * as inHouseImpl from "./identity-in-house";

const provider = (import.meta.env.VITE_AUTH_PROVIDER ?? "clerk") as
  | "clerk"
  | "dual"
  | "in_house";

export interface DashboardIdentity {
  email: string | null;
  role: "admin" | "agent" | "customer" | null;
  displayName: string | null;
  userId: string | null;
  signOut: () => Promise<void>;
}

/**
 * Read the current dashboard identity. Returns null-shaped values
 * for fields when no session is present; callers should branch
 * on `email !== null` (or wrap with a session gate).
 */
export const useDashboardIdentity: () => DashboardIdentity =
  provider === "in_house"
    ? inHouseImpl.useDashboardIdentity
    : clerkImpl.useDashboardIdentity;

/** True when the SPA is configured to use the in-house auth path. */
export const IS_IN_HOUSE_AUTH = provider === "in_house";
