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
 *   The default is `"admin"` so that components rendered OUTSIDE
 *   the AppShell (e.g. a Storybook story or a unit test that
 *   forgets to wrap with the provider) behave as full-privilege
 *   admins. The trade-off: a missing-provider bug in production
 *   would silently UN-restrict an agent rather than silently
 *   over-restrict an admin. We accept this because (a) the
 *   server-side `requireAdminOnly` is the actual security
 *   boundary — UI hiding is purely a UX nicety, and (b) the
 *   single AppShell entry point makes a missing-provider bug
 *   structurally hard to introduce.
 */
export type AdminRole = "admin" | "agent";

const RoleContext = createContext<AdminRole>("admin");

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
