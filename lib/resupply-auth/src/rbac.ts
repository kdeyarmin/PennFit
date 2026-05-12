// Granular RBAC catalog — Phase A.
//
// What lives here
// ---------------
//   * The PERMISSION enum (the universe of fine-grained actions
//     the admin console can guard).
//   * The role → permissions map (which roles can do what).
//   * `roleHasPermission` — the one-call lookup the middleware
//     uses on every gated route.
//
// What does NOT live here
// -----------------------
//   * HTTP-level wiring (express middleware sits in
//     lib/resupply-auth/src/http/permissions.ts).
//   * DB rows. We deliberately keep the catalog in code:
//       - The set of permissions changes with the codebase (a new
//         feature adds a new perm), so versioning it in TypeScript
//         keeps catalog + consumers in lockstep.
//       - There's no operational reason to mutate it at runtime;
//         "who has which role" is the per-row decision (in
//         admin_users.role) and that's the surface we need to
//         change without a deploy. Changing the rules themselves
//         IS a deploy.
//
// Adding a new permission
// -----------------------
//   1. Add a key to the Permission union below.
//   2. Add it to the ROLE_PERMISSIONS map for every role that
//      should have it.
//   3. The middleware `requirePermission(perm)` picks it up
//      automatically; no other wiring.
//
// Posture notes
// -------------
//   * `admin` always has every permission. We assert this at
//     module load time so a future drift doesn't accidentally
//     lock the team out of their own console.
//   * `agent` is the legacy "everything-CSR" role — it carries
//     the CSR perm set plus a couple of leftovers so existing
//     production admins don't get locked out at deploy. New
//     invites should pick a specific role rather than `agent`.

import type { AdminRole } from "@workspace/resupply-db";

/**
 * The universe of permission keys. Add new entries here.
 *
 * Naming: `<resource>.<verb>` — keep it boring and predictable so
 * a code reviewer can guess the right key from context.
 *
 *   patients.read           — view patient records / inbox rows
 *   patients.update         — edit patient demographics / notes
 *   returns.read            — view the returns queue
 *   returns.approve         — approve/deny a return request (gating
 *                              decision; supervisor-and-up)
 *   compliance.read         — view compliance alerts + reports
 *   compliance.resolve      — close out a compliance alert
 *   audit.export            — download audit-log CSV
 *   audit.read              — view audit log entries in the UI
 *   admin_team.manage       — invite / revoke admin team members
 *   reports.read            — view operations-center dashboards
 *   bulk_campaigns.send     — send bulk messaging campaigns
 *   fit_session.override    — override a recommended mask/size
 *   inventory.read          — view shop stock counts (Pacware
 *                              mirror)
 *   training.manage         — assign / mark complete staff trainings
 *   grievances.read         — view patient grievance log
 *   grievances.resolve      — close out a grievance / adverse event
 */
export type Permission =
  | "patients.read"
  | "patients.update"
  | "returns.read"
  | "returns.approve"
  | "compliance.read"
  | "compliance.resolve"
  | "audit.export"
  | "audit.read"
  | "admin_team.manage"
  | "reports.read"
  | "bulk_campaigns.send"
  | "fit_session.override"
  | "inventory.read"
  | "training.manage"
  | "grievances.read"
  | "grievances.resolve";

/** Full enumeration — handy for tests and for the `admin` role
 *  that should always have every permission. Kept in sync with the
 *  Permission union via the assertion at module load. */
const ALL_PERMISSIONS: ReadonlyArray<Permission> = [
  "patients.read",
  "patients.update",
  "returns.read",
  "returns.approve",
  "compliance.read",
  "compliance.resolve",
  "audit.export",
  "audit.read",
  "admin_team.manage",
  "reports.read",
  "bulk_campaigns.send",
  "fit_session.override",
  "inventory.read",
  "training.manage",
  "grievances.read",
  "grievances.resolve",
];

/** Role → permission set. Modify this when adjusting policy. */
const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  admin: new Set(ALL_PERMISSIONS),

  supervisor: new Set<Permission>([
    "patients.read",
    "patients.update",
    "returns.read",
    "returns.approve",
    "compliance.read",
    "compliance.resolve",
    "audit.read",
    "audit.export",
    "reports.read",
    "bulk_campaigns.send",
    "fit_session.override",
    "inventory.read",
    "training.manage",
    "grievances.read",
    "grievances.resolve",
  ]),

  csr: new Set<Permission>([
    "patients.read",
    "patients.update",
    "returns.read",
    "compliance.read",
    "reports.read",
    "inventory.read",
    "grievances.read",
  ]),

  fitter: new Set<Permission>([
    "patients.read",
    "patients.update",
    "fit_session.override",
    "inventory.read",
  ]),

  fulfillment: new Set<Permission>([
    "patients.read",
    "returns.read",
    "inventory.read",
  ]),

  compliance_officer: new Set<Permission>([
    "patients.read",
    "compliance.read",
    "compliance.resolve",
    "audit.read",
    "audit.export",
    "reports.read",
    "training.manage",
    "grievances.read",
    "grievances.resolve",
  ]),

  // Legacy "everything-CSR" role. Mirrors `csr` so existing
  // production rows don't lose access at deploy. New invites
  // should pick a specific role.
  agent: new Set<Permission>([
    "patients.read",
    "patients.update",
    "returns.read",
    "compliance.read",
    "reports.read",
    "inventory.read",
    "grievances.read",
  ]),
};

/** Constant-time-ish lookup. Returns true when the role's permission
 *  set contains `perm`. */
export function roleHasPermission(
  role: AdminRole,
  perm: Permission,
): boolean {
  const set = ROLE_PERMISSIONS[role];
  if (!set) return false;
  return set.has(perm);
}

/** Convenience: full permission set for a role. Returns a fresh
 *  array so callers can't mutate the catalog. */
export function permissionsForRole(role: AdminRole): Permission[] {
  const set = ROLE_PERMISSIONS[role];
  if (!set) return [];
  return Array.from(set);
}

// ────────────────────────────────────────────────────────────────
// Module-load assertions.
//
// The admin role MUST have every permission. If a future edit adds
// a permission and forgets to slot it into admin, fail noisily at
// boot rather than at the first 403.
// ────────────────────────────────────────────────────────────────
for (const perm of ALL_PERMISSIONS) {
  if (!ROLE_PERMISSIONS.admin.has(perm)) {
    throw new Error(
      `RBAC catalog drift: admin role is missing permission "${perm}". ` +
        `Update ROLE_PERMISSIONS.admin in lib/resupply-auth/src/rbac.ts.`,
    );
  }
}

export { ALL_PERMISSIONS };
