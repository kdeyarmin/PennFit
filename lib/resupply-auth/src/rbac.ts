// Granular RBAC catalog — Phase B (3-role effective model).
//
// The product now exposes only THREE conceptual roles to the team UI
// and ops: `super_admin`, `admin`, and `customer_service_rep`. The
// DB enum on admin_users.role still carries the historical 7-role
// set ('admin', 'supervisor', 'csr', 'fitter', 'fulfillment',
// 'compliance_officer', 'agent') so we don't have to gate this on a
// schema migration; we collapse the 7 DB names into 3 effective
// buckets at lookup time via `toEffectiveRole(...)`. A follow-up PR
// will land the enum change once the migration-drift work in
// docs/migration-drift-status-2026-05-13.md is unblocked.
//
// What lives here
// ---------------
//   * The Permission enum (fine-grained actions the admin console
//     can guard).
//   * EffectiveRole — the 3 roles the rest of the app cares about.
//   * `toEffectiveRole(dbRole)` — the DB → effective normalizer.
//   * EFFECTIVE_ROLE_PERMISSIONS — the role → permissions map keyed
//     by EffectiveRole.
//   * `roleHasPermission(dbRole, perm)` — the one-call lookup the
//     middleware uses on every gated route. Normalizes internally.
//
// Mapping (union of perms; no role loses access on the rollover):
//   * super_admin           ← db: admin
//   * admin                 ← db: supervisor + compliance_officer
//   * customer_service_rep  ← db: csr + fitter + fulfillment + agent
//   * clinician             ← db: rt
//
// What does NOT live here
// -----------------------
//   * HTTP-level wiring (lib/resupply-auth/src/http/permissions.ts).
//   * DB rows. The catalog stays in code: the set of permissions
//     changes with the codebase (a new feature adds a new perm),
//     so versioning it in TypeScript keeps catalog + consumers in
//     lockstep. Per-row role assignments live in admin_users.role
//     and remain the runtime surface ops change without a deploy.
//
// Adding a new permission
// -----------------------
//   1. Add a key to the Permission union below.
//   2. Add it to the EFFECTIVE_ROLE_PERMISSIONS map for every
//      effective role that should have it.
//   3. `requirePermission(perm)` picks it up automatically.
//
// Posture notes
// -------------
//   * `super_admin` always has every permission. We assert this at
//     module load so a future drift can't lock the team out of
//     their own console.

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
 *   returns.manage          — open / transition / annotate loss claims,
 *                              proof-of-delivery, and other fulfillment-
 *                              lifecycle ops below the approve gate
 *   compliance.read         — view compliance alerts + reports
 *   compliance.resolve      — close out a compliance alert
 *   audit.export            — download audit-log CSV
 *   audit.read              — view audit log entries in the UI
 *   admin_team.manage       — invite / revoke admin team members
 *   reports.read            — view operations-center dashboards
 *   cost.read               — view unit cost / COGS / margin figures
 *                              (finance-gated; off front-line CSRs)
 *   cost.write              — set / edit unit cost per SKU
 *   metrics.read            — view KPI metric alerts / dashboards
 *                              (management-gated; off front-line CSRs)
 *   bulk_campaigns.send     — send bulk messaging campaigns
 *   fit_session.override    — override a recommended mask/size
 *   inventory.read          — view shop stock counts (Pacware
 *                              mirror)
 *   conversations.manage    — triage admin inbox: snooze, tag, claim
 *   admin.tools.manage      — supervisor-tier CSR-tool management
 *                              (macro templates, future quick-actions)
 *   clinical.read           — view clinical encounters / patient
 *                              clinical timeline (rt + management)
 *   clinical.note.write     — author a clinical encounter note
 *   clinical.intervention.write — record a structured intervention plan
 *   cases.read              — view CSR cases (cross-channel tickets)
 *   cases.manage            — open / edit / link cases
 *   targets.manage          — set / view business goals (management)
 *   system.config.manage    — read/write the System Configuration store
 *                              (integration credentials + platform
 *                              secrets). super_admin ONLY — like
 *                              admin_team.manage, it is deliberately
 *                              left out of every non-super_admin role
 *                              set below so only the top role can view
 *                              or enter secrets.
 */
export type Permission =
  | "patients.read"
  | "patients.update"
  | "returns.read"
  | "returns.approve"
  | "returns.manage"
  | "compliance.read"
  | "compliance.resolve"
  | "audit.export"
  | "audit.read"
  | "admin_team.manage"
  | "reports.read"
  | "cost.read"
  | "cost.write"
  | "metrics.read"
  | "bulk_campaigns.send"
  | "fit_session.override"
  | "inventory.read"
  | "conversations.manage"
  | "admin.tools.manage"
  | "clinical.read"
  | "clinical.note.write"
  | "clinical.intervention.write"
  | "cases.read"
  | "cases.manage"
  | "targets.manage"
  | "system.config.manage";

/** Full enumeration — handy for tests and for the `admin` role
 *  that should always have every permission. Kept in sync with the
 *  Permission union via the assertion at module load. */
const ALL_PERMISSIONS: ReadonlyArray<Permission> = [
  "patients.read",
  "patients.update",
  "returns.read",
  "returns.approve",
  "returns.manage",
  "compliance.read",
  "compliance.resolve",
  "audit.export",
  "audit.read",
  "admin_team.manage",
  "reports.read",
  "cost.read",
  "cost.write",
  "metrics.read",
  "bulk_campaigns.send",
  "fit_session.override",
  "inventory.read",
  "conversations.manage",
  "admin.tools.manage",
  "clinical.read",
  "clinical.note.write",
  "clinical.intervention.write",
  "cases.read",
  "cases.manage",
  "targets.manage",
  "system.config.manage",
];

/**
 * The four roles the product actually distinguishes:
 *   * super_admin           — full surface; team management;
 *                              destructive ops (audit-archive
 *                              destruction, etc.).
 *   * admin                 — broad management without the most
 *                              destructive ops; can approve returns,
 *                              export audit, resolve compliance
 *                              alerts, and manage cost / metrics.
 *   * customer_service_rep  — operational CSR + clinical fitter +
 *                              fulfillment + legacy "agent" all
 *                              folded together. Day-to-day patient
 *                              and returns work; no money-out, no
 *                              compliance resolution.
 *   * clinician             — respiratory therapist (rt). Clinical
 *                              encounter documentation + patient read.
 */
export type EffectiveRole =
  | "super_admin"
  | "admin"
  | "customer_service_rep"
  | "clinician";

/**
 * Normalize a DB-persisted role to the 3-bucket effective model.
 *
 * The DB enum still carries the historical 7-role set (see
 * lib/resupply-db/src/schema/admin-users.ts). This collapse layer
 * keeps the runtime permission catalog small while preserving every
 * production row's access — each DB role maps to exactly one
 * effective role and the effective role's perm set is the UNION of
 * the DB roles that fold into it.
 */
export function toEffectiveRole(role: AdminRole): EffectiveRole {
  switch (role) {
    case "admin":
      return "super_admin";
    case "supervisor":
    case "compliance_officer":
      return "admin";
    case "rt":
      return "clinician";
    case "csr":
    case "fitter":
    case "fulfillment":
    case "agent":
    default:
      return "customer_service_rep";
  }
}

/** Effective-role → permission set. */
const EFFECTIVE_ROLE_PERMISSIONS: Record<
  EffectiveRole,
  ReadonlySet<Permission>
> = {
  // Full surface. Asserted below to always equal ALL_PERMISSIONS so
  // a forgotten entry can't accidentally lock the team out.
  super_admin: new Set(ALL_PERMISSIONS),

  // Union of legacy `supervisor` + `compliance_officer`. Excludes
  // only `admin_team.manage` — team management stays super-admin-
  // only, matching the pre-collapse posture.
  admin: new Set<Permission>([
    "patients.read",
    "patients.update",
    "returns.read",
    "returns.approve",
    "returns.manage",
    "compliance.read",
    "compliance.resolve",
    "audit.read",
    "audit.export",
    "reports.read",
    "cost.read",
    "cost.write",
    "metrics.read",
    "bulk_campaigns.send",
    "fit_session.override",
    "inventory.read",
    "conversations.manage",
    "admin.tools.manage",
    "clinical.read",
    "clinical.note.write",
    "clinical.intervention.write",
    "cases.read",
    "cases.manage",
    "targets.manage",
  ]),

  // Union of legacy `csr` + `fitter` + `fulfillment` + `agent`.
  // CSR was the largest contributor; fitter added
  // `fit_session.override`; fulfillment's returns perms were
  // already in csr; agent was a CSR mirror. No new perms beyond
  // what those four roles collectively held.
  customer_service_rep: new Set<Permission>([
    "patients.read",
    "patients.update",
    "returns.read",
    "returns.manage",
    "compliance.read",
    "reports.read",
    "inventory.read",
    "conversations.manage",
    "fit_session.override",
    "cases.read",
    "cases.manage",
  ]),

  // Respiratory therapist (rt). Clinical documentation + the patient
  // context needed to do it. No money-out, no team management, no
  // returns approval.
  clinician: new Set<Permission>([
    "patients.read",
    "clinical.read",
    "clinical.note.write",
    "clinical.intervention.write",
  ]),
};

/**
 * Constant-time-ish lookup. Normalizes the DB role to the 3-bucket
 * effective role, then asks whether that bucket contains `perm`.
 */
export function roleHasPermission(role: AdminRole, perm: Permission): boolean {
  const effective = toEffectiveRole(role);
  const set = EFFECTIVE_ROLE_PERMISSIONS[effective];
  return set.has(perm);
}

/** Convenience: full permission set for a DB role (via its effective
 *  bucket). Returns a fresh array so callers can't mutate the
 *  catalog. */
export function permissionsForRole(role: AdminRole): Permission[] {
  const effective = toEffectiveRole(role);
  return Array.from(EFFECTIVE_ROLE_PERMISSIONS[effective]);
}

// ────────────────────────────────────────────────────────────────
// Module-load assertions.
//
// The super_admin effective role MUST hold every permission. If a
// future edit adds a permission and forgets to slot it into
// super_admin, fail noisily at boot rather than at the first 403.
// ────────────────────────────────────────────────────────────────
for (const perm of ALL_PERMISSIONS) {
  if (!EFFECTIVE_ROLE_PERMISSIONS.super_admin.has(perm)) {
    throw new Error(
      `RBAC catalog drift: super_admin role is missing permission "${perm}". ` +
        `Update EFFECTIVE_ROLE_PERMISSIONS.super_admin in lib/resupply-auth/src/rbac.ts.`,
    );
  }
}

export { ALL_PERMISSIONS };
