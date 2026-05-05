import { createContext, useContext, type ReactNode } from "react";

/**
 * RoleContext — propagates the signed-in caller's role
 * (`"admin"` | `"agent"`) from the shell down to any page that
 * needs to hide or disable destructive UI affordances.
 *
 * Why a context (not prop drilling):
 *   The role is set once per session at the top of the tree
 *   (AppShell receives it from /me) and is read by leaf pages
 *   that are several routes deep. Threading it through every
 *   intermediate component would be noisy and brittle — adding
 *   a new destructive button anywhere would require updating
 *   every parent route. A read-only context lets the shell own
 *   the value and any leaf opt in.
 *
 * Default value:
 *   The default is `"agent"` (most restrictive) so that a component
 *   rendered OUTSIDE the RoleProvider (e.g. a unit test or a new
 *   route that omits the provider) silently over-restricts rather
 *   than silently grants full admin privileges. The server-side
 *   `requireAdminOnly` remains the real security boundary; this
 *   default is defence-in-depth for the UI layer.
 */
export type AdminRole = "admin" | "agent";

const RoleContext = createContext<AdminRole>("agent");

export function RoleProvider({
  role,
  children,
}: {
  role: AdminRole;
  children: ReactNode;
}) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useAdminRole(): AdminRole {
  return useContext(RoleContext);
}
