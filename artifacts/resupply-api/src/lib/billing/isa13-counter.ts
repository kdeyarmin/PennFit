// Atomic ISA13 reservation via resupply.control_number_counters
// (migration 0308).
//
// The legacy allocation read MAX(isa_control_number) from
// office_ally_submissions and added 1 — which (a) never saw the
// eligibility 270s' numbers (they persist into eligibility_checks, a
// different table, so two checks in the same second collided
// deterministically) and (b) raced concurrent submissions, with no
// transaction to close the read-then-insert window. Because the
// submission row is only inserted AFTER the SFTP upload, a unique
// index can't save the day either — the duplicate is already on the
// wire by the time it fires.
//
// This helper CAS-increments the TENANT'S counter row BEFORE anything is
// built or uploaded: read the current value, UPDATE ... WHERE value =
// <seen>; at most one concurrent caller matches, losers re-read and
// retry. Per-tenant since migration 0361 (PK (org_id, pool)): the caller
// passes its org-scoped client and the facade constrains every read/CAS to
// that tenant's counter, so two tenants (distinct EDI submitters) never
// draw from the same ISA13 sequence.

import type { OrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

const POOL = "office_ally_isa13";
const MAX_CAS_ATTEMPTS = 8;

/**
 * Reserve the next ISA13 value atomically WITHIN the caller's tenant.
 * Returns the reserved NUMERIC value. A tenant with no counter row yet
 * (freshly onboarded) is SELF-PROVISIONED on first use — we idempotently
 * create its row at 0 and retry — so every tenant gets the atomic CAS path
 * rather than silently falling back to the inferior legacy allocator (which
 * misses the 270 eligibility ISA13s and races concurrent submissions).
 * Returns `null` only when the counter table is entirely absent (migration
 * 0308 not applied) or the row can't be created/read, so callers can still
 * fall back to the legacy org-scoped MAX-read and deploy ordering can't
 * break submissions. Throws on persistent CAS contention or query errors.
 */
export async function reserveIsa13Value(
  supabase: OrgScopedClient,
): Promise<number | null> {
  let provisioned = false;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    // The org-scoped facade appends `.eq("org_id", supabase.orgId)` to both
    // the read and the CAS update, so the reservation is per (org, pool).
    const { data: row, error: readErr } = await supabase
      .from("control_number_counters")
      .select("value")
      .eq("pool", POOL)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      // Provision this tenant's counter row at most ONCE. If, after a
      // successful create, the row still isn't readable (the counter table
      // is absent, or the store didn't persist), fall back to null rather
      // than spin — callers then use the legacy org-scoped MAX-read.
      if (provisioned) {
        logger.warn(
          { pool: POOL, orgId: supabase.orgId },
          "isa13-counter: tenant counter row not readable after create — falling back to legacy MAX-read allocation",
        );
        return null;
      }
      // Create it (idempotent: a concurrent caller may win the insert) and
      // retry. The facade injects org_id; a brand-new tenant has no prior
      // submissions, so starting at 0 cannot re-mint a used control number.
      const { error: createErr } = await supabase
        .from("control_number_counters")
        .upsert(
          { pool: POOL, value: 0 },
          { onConflict: "org_id,pool", ignoreDuplicates: true },
        );
      if (createErr) {
        logger.warn(
          { pool: POOL, orgId: supabase.orgId, err: createErr.message },
          "isa13-counter: could not create tenant counter row — falling back to legacy MAX-read allocation",
        );
        return null;
      }
      provisioned = true;
      continue;
    }
    const seen = Number((row as { value: number | string }).value);
    const next = seen + 1;
    const { data: claimed, error: casErr } = await supabase
      .from("control_number_counters")
      .update({ value: next, updated_at: new Date().toISOString() })
      .eq("pool", POOL)
      .eq("value", seen)
      .select("pool");
    if (casErr) throw casErr;
    if (claimed && claimed.length > 0) return next;
    // Lost the CAS to a concurrent reservation — re-read and retry.
  }
  throw new Error(
    `isa13-counter: failed to reserve a control number after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}
