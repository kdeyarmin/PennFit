// Staff role vocabulary for /admin/team — the labels shown on a member
// row, the roles offered in the invite + change-role selectors, and the
// one-line scope hint beside each option.
//
// Lives beside `TeamRole` (admin-team-api.ts) rather than inside the
// page component so it can be unit-tested without rendering React, and
// so the exhaustive `Record<TeamRole, string>` below fails the build the
// day a new role joins the union without a label.
//
// Server-side counterparts, which must stay in step:
//   * ROLE_VALUES        — artifacts/resupply-api/src/routes/admin/team.ts
//                          (what the invite/PATCH endpoints accept)
//   * staffRoleProfile() — artifacts/resupply-api/src/lib/help-docs/roles.ts
//                          (the job title, duties, and handbook PDFs the
//                          invitation email carries)

import type { TeamRole } from "./admin-team-api";

/**
 * Display labels for every DB-persisted role. Legacy values map onto
 * one of the effective buckets so the UI shows a consistent vocabulary
 * even for rows persisted under one of the older role names.
 *
 * "Super Admin" is deliberately NOT used here: it now names the GLOBAL
 * platform tier (platform_admins — see the /platform super-admin
 * console), which sits above every tenant. A tenant's TOP role is the
 * "Owner" (full access within that one tenant, including its System
 * Configuration); the mid tier is "Admin".
 */
export const ROLE_LABEL: Record<TeamRole, string> = {
  admin: "Owner",
  supervisor: "Admin",
  compliance_officer: "Admin",
  csr: "Customer service rep",
  fitter: "Customer service rep",
  fulfillment: "Customer service rep",
  agent: "Customer service rep",
  rt: "Respiratory therapist",
  biller: "Biller",
};

/**
 * Roles offered in the invite + change-role selectors: the two general
 * buckets (Owner, Admin), the front-line bucket (Customer service rep),
 * and the two job-scoped roles (Biller, Respiratory therapist). Order
 * matches the platform console's tenant-admin selector.
 *
 * Existing rows persisted under a legacy name (compliance_officer,
 * fitter, fulfillment, agent) continue to resolve correctly through
 * ROLE_LABEL above; new invites pick exactly one of these.
 */
export const ROLE_OPTIONS = [
  "admin",
  "supervisor",
  "csr",
  "biller",
  "rt",
] as const satisfies readonly TeamRole[];

/** The subset of TeamRole a new invite (or a role change) may pick. */
export type OfferedRole = (typeof ROLE_OPTIONS)[number];

/**
 * One-line scope hint rendered beside each option in the invite
 * selector. Picking a role decides both what the member can see and
 * which handbook their welcome email carries, so the person inviting
 * should not have to guess. Keep each in step with the matching entry
 * in EFFECTIVE_ROLE_PERMISSIONS (lib/resupply-auth/src/rbac.ts).
 */
export const ROLE_HINT: Record<OfferedRole, string> = {
  admin: "full privileges, including team and system configuration",
  supervisor:
    "runs the practice day to day; no team management or system configuration",
  csr: "conversations, patients, orders, fittings, returns",
  biller: "the billing area, plus the patient and cost context behind a claim",
  rt: "therapy monitoring, fit review, clinical documentation",
};
