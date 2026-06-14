// Org-scoped Supabase client — the multi-tenant isolation chokepoint.
//
// See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md
// (workstream C). A thin facade over the service-role client whose
// `.from(table)` automatically:
//   - appends `.eq("org_id", orgId)` to every select / update / delete,
//   - injects `org_id: orgId` into every insert / upsert payload.
//
// Routing ALL tenant-scoped data access through this single function —
// rather than calling `getSupabaseServiceRoleClient()` directly — is
// what makes tenant isolation a structural property of the code instead
// of a per-route discipline. The CI guard `scripts/check-tenant-
// isolation.sh` enforces that application code reaches the DB through
// here.
//
// SAFE TO LAND BEFORE THE CUTOVER: no application route imports this yet
// (the cutover swaps the ~1,592 direct `getSupabaseServiceRoleClient()`
// callsites over to it, per domain). Making the facade real therefore
// changes NO production behavior — it just makes the chokepoint
// functional and unit-tested, ready for the incremental cutover.
//
// Tables operate in the `resupply` schema (where every tenant table
// lives). Global / non-tenant tables (the `organizations` directory
// itself, reference catalogs, the migration ledger) are NOT reached
// through `.from()` — use `.raw()` for those and for RPC. Defaulting
// `.from()` to ALWAYS scope is deliberate: failing toward over-scoping
// is far safer than silently passing a tenant table through unscoped.
//
// NOTE: the GUC for the RLS backstop (`app.current_org_id`) is set with
// the RLS-policy migration (workstream D), not here — service_role
// bypasses RLS today, so the app-layer filter in this facade is the
// real isolation guarantee.

import type { Database } from "./supabase-types";
import {
  getSupabaseServiceRoleClient,
  type ResupplySupabaseClient,
} from "./supabase-client";

/** Stable slug of the seed tenant (the original operating company). */
export const SEED_ORG_SLUG = "penn-home-medical";

/** The tenant-anchor column present on every tenant-scoped table. */
export const ORG_COLUMN = "org_id" as const;

/** Names of the tenant-scoped tables in the `resupply` schema. */
export type ResupplyTable = keyof Database["resupply"]["Tables"] & string;

// The underlying PostgREST query builder is fluent and dynamically
// typed across its many overloads; wrapping it faithfully without
// re-deriving Supabase's full generic surface requires a small, local
// escape hatch. Scoped to just the builder shim below.
/* eslint-disable @typescript-eslint/no-explicit-any */
type UnderlyingQueryBuilder = {
  select: (columns?: string, options?: any) => any;
  insert: (values: any, options?: any) => any;
  update: (values: any, options?: any) => any;
  upsert: (values: any, options?: any) => any;
  delete: (options?: any) => any;
};

/**
 * A `.from(table)` result that auto-applies the tenant filter / tag.
 * Each method returns the underlying PostgREST builder so the rest of
 * the chain (`.eq`, `.order`, `.limit`, `.single`, `await`, …) works
 * natively and unchanged.
 */
class OrgScopedQueryBuilder {
  constructor(
    private readonly qb: UnderlyingQueryBuilder,
    private readonly orgId: string,
  ) {}

  /** SELECT, scoped to the tenant. */
  select(columns?: string, options?: any) {
    return this.qb.select(columns, options).eq(ORG_COLUMN, this.orgId);
  }

  /** INSERT, with the tenant id forced onto every row. */
  insert(values: any, options?: any) {
    return this.qb.insert(this.tag(values), options);
  }

  /** UPDATE, scoped so a tenant can only update its own rows. The
   *  tenant id is also forced onto the patch so an update can't move a
   *  row to another tenant. */
  update(values: any, options?: any) {
    return this.qb
      .update({ ...values, [ORG_COLUMN]: this.orgId }, options)
      .eq(ORG_COLUMN, this.orgId);
  }

  /** UPSERT, with the tenant id forced onto every row. */
  upsert(values: any, options?: any) {
    return this.qb.upsert(this.tag(values), options);
  }

  /** DELETE, scoped so a tenant can only delete its own rows. */
  delete(options?: any) {
    return this.qb.delete(options).eq(ORG_COLUMN, this.orgId);
  }

  /** Force the tenant id onto a single payload or an array of them. */
  private tag(values: any): any {
    if (Array.isArray(values)) {
      return values.map((v) => ({ ...v, [ORG_COLUMN]: this.orgId }));
    }
    return { ...values, [ORG_COLUMN]: this.orgId };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A Supabase facade bound to a single tenant. */
export interface OrgScopedClient {
  /** The tenant this client is bound to. */
  readonly orgId: string;
  /** Tenant-scoped access to a `resupply` table. */
  from(table: ResupplyTable): OrgScopedQueryBuilder;
  /**
   * Escape hatch: the unscoped service-role client, for global /
   * non-tenant tables (the `organizations` directory, reference
   * catalogs) and RPC. Use sparingly and never for tenant data.
   */
  raw(): ResupplySupabaseClient;
}

/**
 * Return a Supabase client scoped to the given tenant. Every
 * `.from(table)` read/write is automatically constrained to (and
 * tagged with) `orgId`.
 *
 * @param orgId  tenant id (resolved from `req.orgId` in auth middleware)
 * @param client test seam — defaults to the shared service-role client
 */
export function getOrgScopedClient(
  orgId: string,
  client: ResupplySupabaseClient = getSupabaseServiceRoleClient(),
): OrgScopedClient {
  if (!orgId || !orgId.trim()) {
    // Fail closed: a missing tenant must never silently widen to
    // "every tenant". Callers resolve `req.orgId` in auth middleware
    // (Phase 0 workstream B) and that path already fails closed; this
    // is the defense-in-depth assertion at the data boundary.
    throw new Error(
      "getOrgScopedClient requires a non-empty orgId (tenant context missing).",
    );
  }
  return {
    orgId,
    from(table: ResupplyTable): OrgScopedQueryBuilder {
      const qb = client
        .schema("resupply")
        .from(table) as unknown as UnderlyingQueryBuilder;
      return new OrgScopedQueryBuilder(qb, orgId);
    },
    raw(): ResupplySupabaseClient {
      return client;
    },
  };
}

let cachedSeedOrgId: string | null = null;

/**
 * Resolve the id of the seed tenant (`SEED_ORG_SLUG`) — the original
 * operating company that all current data belongs to.
 *
 * This is a TENANT-DIRECTORY read (it resolves *which* org), not a
 * tenant-scoped one, so it legitimately goes through the service-role
 * client and lives here in the db package rather than behind
 * `getOrgScopedClient`.
 *
 * Phase 0 usage (PR 0.2): the auth middleware calls this to attach
 * `req.orgId`. While the platform is single-tenant every caller resolves
 * to this one org; once `admin_users` / `shop_customers` carry their own
 * `org_id` (later backfill batches) the middleware reads the per-user
 * column instead and this becomes the fallback for unscoped/system paths.
 *
 * Returns null (rather than throwing) on a lookup miss/error so callers
 * can decide their own posture; the result is cached on success.
 */
export async function resolveSeedOrgId(): Promise<string | null> {
  if (cachedSeedOrgId) return cachedSeedOrgId;
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("organizations")
    .select("id")
    .eq("slug", SEED_ORG_SLUG)
    .limit(1)
    .maybeSingle();
  if (error || !data?.id) return null;
  cachedSeedOrgId = data.id;
  return cachedSeedOrgId;
}

/** Reset the cached seed-org id. Tests only. */
export function __resetSeedOrgIdForTests(): void {
  cachedSeedOrgId = null;
}
