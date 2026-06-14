# Multi-Tenant Enforcement: Cutover Playbook

**Date:** 2026-06-14
**Status:** Working playbook for the Phase 0 enforcement cutover
**Parents:**
[`multi-tenant-caremetric-strategy-2026-06-14.md`](./multi-tenant-caremetric-strategy-2026-06-14.md),
[`multi-tenant-phase-0-engineering-plan-2026-06-14.md`](./multi-tenant-phase-0-engineering-plan-2026-06-14.md)

The additive foundation is merged (#778): every tenant-scoped table has a
nullable, backfilled, indexed `org_id`; `req.orgId` resolves in the auth
middleware; and `getOrgScopedClient(orgId)` is a real, unit-tested
scoping facade. The pilot PR (#786) proves the route-cutover pattern on
two admin routes.

This doc is the **repeatable recipe** for converting the remaining
~1,590 `getSupabaseServiceRoleClient()` callsites and finishing
enforcement. Do the bulk in a **Node-24 session** where the full
Vitest/Playwright suite gates each PR.

---

## The per-route cutover recipe

For a route handler that reads/writes tenant-scoped tables:

1. **Swap the import**

   ```diff
   - import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
   + import { getOrgScopedClient } from "@workspace/resupply-db";
   ```

2. **Resolve the tenant fail-closed, at the top of each handler**

   ```ts
   const orgId = req.orgId; // attached by requireAdmin / requireSignedIn
   if (!orgId) {
     res.status(500).json({ error: "tenant_context_missing" });
     return;
   }
   const db = getOrgScopedClient(orgId);
   ```

   For files with several handlers, factor a `resolveOrg(req, res)` helper
   (see `patient-therapy-links.ts`). Never widen to all tenants on a
   missing `orgId` — refuse.

3. **Replace the access path**

   ```diff
   - const supabase = getSupabaseServiceRoleClient();
   - await supabase.schema("resupply").from("patients").select(...)…
   + await db.from("patients").select(...)…
   ```

   The facade auto-appends `.eq("org_id", orgId)` to `select/update/delete`
   and forces `org_id` onto `insert/upsert` payloads. The rest of the
   chain (`.eq`, `.order`, `.limit`, `.single`, `await`) is unchanged —
   `db.from()` returns the native PostgREST builder after the scoping
   step.

4. **Verify**
   - `tsc --build` clean,
   - the file no longer appears in `scripts/check-tenant-isolation.sh`,
   - the route's existing tests pass (Node-24 suite).

A cut-over route is **behavior-preserving in single-tenant**: all rows
belong to the seed org and `req.orgId` resolves to it, so the `org_id`
filter changes no results — it begins isolating the moment a second
tenant exists.

---

## Decision table — what to use where

| Situation                                                                                           | Use                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Read/write a tenant-scoped `resupply` table in a request handler                                    | `getOrgScopedClient(req.orgId).from(table)`                                                                       |
| **Global / non-tenant** table (`organizations` directory, reference catalogs, the migration ledger) | `getOrgScopedClient(orgId).raw()` (or the raw client) — never `.from()`                                           |
| **RPC** (`.rpc(...)`)                                                                               | `.raw().rpc(...)` — RPCs scope themselves internally; revisit per-function                                        |
| Resolving _which_ org (the directory itself)                                                        | `resolveSeedOrgId()` / a future `resolveOrgBy…` — not the scoped client                                           |
| **Worker / job** code (no `req`)                                                                    | The job payload must carry `org_id`; pass it to `getOrgScopedClient(payload.orgId)`. Do **not** invent a default. |

---

## Gotchas (learned in the pilot)

- **Loosely-typed builder returns.** `db.from(...)` methods currently
  return the dynamically-typed PostgREST builder (the facade uses a
  scoped `any` internally). Reads/writes compile and run, but you lose
  column-level type-checking on the chained result. If review wants it,
  invest in fully-typed facade returns _before_ the broad fan-out — every
  cut-over file inherits the choice.
- **Projections that build a full `Row`.** Adding `org_id` to a table's
  `Row` type means any explicit full-column `.select("…")` that feeds a
  `Row`-typed mapper must include `org_id` (already fixed in
  `identity-resolver`, `patient-therapy-links`, `message-templates`,
  `payer-fee-schedules` during the backfills). `tsc --build` flags these.
- **`raw-pg` worker paths bypass the facade.** A few legacy workers use
  `getDbPool()` (e.g. `worker/jobs/bulk-campaign-tick.ts`). Those are NOT
  covered by `getOrgScopedClient` and must be scoped by hand (explicit
  `WHERE org_id = $1`). This matters doubly for RLS — see below.

---

## Finishing enforcement (the hard, test-backed tail)

Do these only with the Node-24 DB-backed suite green, ideally one PR each:

1. **`org_id` → `NOT NULL`.** Valid only once _every_ insert path supplies
   `org_id` — i.e. after all writers (routes **and** workers) are cut
   over. Tighten per table; keep the FK + index.
2. **Per-tenant RLS policies (workstream D).** `USING (org_id =
current_setting('app.current_org_id', true)::uuid)`. **Landmine:** the
   facade does not set that GUC yet (service_role bypasses RLS, so the
   app-layer filter is the real guarantee today). Before enabling
   fail-closed RLS, confirm **every** non-service-role connection — in
   particular the `raw-pg` workers via `DATABASE_URL` — either bypasses
   RLS (table owner / `BYPASSRLS`) or sets the GUC in its transaction.
   Otherwise those workers silently read zero rows.
3. **Guard → FAIL.** Flip `scripts/check-tenant-isolation.sh` to
   `FAIL_ON_VIOLATION=1` in CI once the only remaining direct
   `getSupabaseServiceRoleClient()` callers are the reviewed global-table
   allowlist. Add the `.test` self-test sibling.
4. **Cross-tenant leakage test (workstream E2).** Seed two orgs in a test
   DB; assert a request scoped to org A cannot read/update/delete any org
   B row across a representative table per domain. This is the regression
   net for the scariest failure mode.

---

## Suggested fan-out order (by blast radius, low → high)

1. Remaining **patient-core** admin routes (started in #786).
2. **Communications** routes (conversations/messages/templates/alerts).
3. **Fulfillment/shop** routes.
4. **Billing/claims** routes + the 837P/835 builders.
5. **Workers** (carry `org_id` in pg-boss payloads; hand-scope raw-pg).
6. Patient-portal (`requireSignedIn`) routes — resolve customer `org_id`
   from `shop_customers.org_id` (extend `customerIdResolver`).

Each domain is an independently reviewable, CI-gated PR. The system stays
single-tenant-correct throughout; multi-tenant onboarding doesn't begin
until enforcement is complete and Phases 1–4 (per-tenant config,
branding, Stripe Connect, per-tenant email/telecom, host routing, and the
loosely-coupled CareMetric cross-linking) layer on top.
