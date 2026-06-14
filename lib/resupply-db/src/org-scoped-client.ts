// Org-scoped Supabase client — the multi-tenant isolation chokepoint.
//
// See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md
// (workstream C). The end-state of this module is a thin facade over
// the service-role client whose `.from(table)` automatically:
//   - appends `.eq("org_id", orgId)` to every select / update / delete,
//   - injects `org_id: orgId` into every insert payload, and
//   - sets the request-scoped GUC the RLS backstop reads.
//
// Routing ALL tenant-scoped data access through this single function —
// rather than calling `getSupabaseServiceRoleClient()` directly — is
// what makes tenant isolation a structural property of the code instead
// of a per-route discipline. The CI guard `scripts/check-tenant-
// isolation.sh` enforces that application code reaches the DB through
// here.
//
// ─────────────────────────────────────────────────────────────────────
// PR 0.1 — SKELETON / NO-OP.
//
// At this stage `organizations` exists and is seeded with tenant #1, but
// no table carries an enforced `org_id` yet (those columns land in the
// per-domain backfill PRs, Phase 0 workstream A2). So this function is a
// deliberate pass-through: it returns the service-role client unchanged
// and does NOT yet filter or inject. That keeps the system single-tenant-
// correct while giving callers the final signature to migrate to and
// giving the CI guard a real symbol to point at. The auto-scoping facade
// is wired in alongside the first domain backfill, once there is an
// `org_id` column to scope on.

import {
  getSupabaseServiceRoleClient,
  type ResupplySupabaseClient,
} from "./supabase-client";

/** Stable slug of the seed tenant (the original operating company). */
export const SEED_ORG_SLUG = "penn-home-medical";

/**
 * Return a Supabase client scoped to the given tenant.
 *
 * PR 0.1: a no-op pass-through to the shared service-role client. The
 * `orgId` is accepted (and validated as present) so callers can be
 * migrated to the final signature now; automatic `org_id` filtering /
 * injection is added with the first domain backfill.
 */
export function getOrgScopedClient(orgId: string): ResupplySupabaseClient {
  if (!orgId || !orgId.trim()) {
    // Fail closed: a missing tenant must never silently widen to
    // "every tenant". Callers resolve `req.orgId` in auth middleware
    // (Phase 0 workstream B) and that path already fails closed; this
    // is the defense-in-depth assertion at the data boundary.
    throw new Error(
      "getOrgScopedClient requires a non-empty orgId (tenant context missing).",
    );
  }
  // No-op for now — see the module header. Once tables carry `org_id`,
  // this returns a scoping facade instead of the raw client.
  return getSupabaseServiceRoleClient();
}
