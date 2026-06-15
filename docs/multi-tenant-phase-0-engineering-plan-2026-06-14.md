# Phase 0 Engineering Plan: Tenancy Foundation

**Date:** 2026-06-14
**Status:** Engineering plan (file-level) — no code committed yet
**Parent doc:** [`multi-tenant-caremetric-strategy-2026-06-14.md`](./multi-tenant-caremetric-strategy-2026-06-14.md)
**Scope:** Phase 0 only — the tenancy foundation that every later phase
(per-tenant config, branding, billing, routing, CareMetric cross-linking)
depends on.

> Phase 0 carries essentially all of the engineering risk in the
> multi-tenant conversion. It is the gate: once it lands, Phases 1–4 are
> largely configuration and packaging. This plan is deliberately
> file-level so it can be sliced into PRs and estimated.

---

## Goal & invariant

Introduce a first-class **tenant** (`organizations`) and make tenant
isolation a **structural property of the code**, not a discipline applied
route-by-route. The single load-bearing invariant:

> **Every tenant-scoped read and write carries an `org_id`, injected at one
> chokepoint, with an RLS backstop and a CI check that fails the build if a
> route bypasses the chokepoint.**

We get isolation right by making the _wrong thing hard to write_, not by
auditing ~100 routes by hand.

---

## Design decisions (locked)

- **Pooled multi-tenancy.** One Supabase project, one deploy, one migration
  run. `org_id uuid` on every tenant-scoped table.
- **App layer is the real guarantee.** The `service_role` client bypasses
  RLS (`lib/resupply-db/src/supabase-client.ts:7`), so the scoped query
  wrapper — not RLS — is what actually separates tenants.
- **RLS is defense-in-depth.** Policies keyed on a request-scoped setting are
  a backstop and the artifact security reviewers/BAAs expect. RLS is already
  enabled on every `resupply`/`resupply_auth` table (migration 0170) with
  anon/authenticated grants revoked (0169) — so this is additive.
- **Backfill, don't break.** Existing data becomes org #1 (Penn Home Medical
  Supply). `org_id` lands nullable → backfilled → `NOT NULL`, in domain
  batches, never one mega-migration.

---

## Workstream A — Data model: `organizations` + `org_id`

### A1. Create the `organizations` table

- **New migration** `lib/resupply-db/drizzle/0XXX_organizations.sql`
  (next free prefix — confirm with `scripts/check-resupply-migration-prefix.sh`).
- Evolve the existing singleton rather than inventing a parallel concept:
  `dme_organization` (migration 0132) already holds billing identity
  (legal_name, tax_id, NPI, PTAN, accreditation). Two viable shapes:
  1. **Rename/promote** `dme_organization` → `organizations`, drop the
     `singleton = true` UNIQUE constraint (its own comment says this is the
     intended "multi-tenant evolution"), add `slug`, `status`,
     `created_at`. **Preferred** — one source of org truth.
  2. Add a thin `organizations(id, slug, name, status)` parent and FK
     `dme_organization.org_id` to it. More tables, more joins; only choose
     if billing identity must stay physically separate from tenant identity.
- Seed org #1 from the current singleton row in the same migration.

### A2. Add `org_id` to tenant-scoped tables (domain batches)

One migration per domain batch, each: `ADD COLUMN org_id uuid` (nullable) →
`UPDATE … SET org_id = <org#1>` → `ALTER … SET NOT NULL` + FK +
`CREATE INDEX … (org_id)`. Suggested batch order (low-risk first):

1. **Patient core** — patients, prescriptions, episodes, fulfillments,
   patient_documents, patient_onboarding_journeys, patient_therapy_links.
2. **Comms** — conversations, messages, message_attachments,
   message_templates, alert_definitions, alert_messages, csr_macros.
3. **Fulfillment / shop** — shop_orders, shop_order_items, shop_customers,
   inventory_reconciliations, office_ally_submissions.
4. **Billing / claims** — insurance_claims, insurance_claim_line_items,
   claim_templates, era_files, prior_authorizations, davinci_pas_submissions,
   eligibility_checks.
5. **Staff / config** — admin_users, locations, feature_flags, app_config
   (config tables become `(org_id, key)` in Phase 1; add the column now).
6. **Analytics / misc** — payer_profiles, payer_fee_schedules,
   claim_scrub_results, patient_checkin_attempts, fitter_leads, etc.

> `~80–100 tables` total. Sequence behind the existing migration ledger and
> deploy gating (CLAUDE.md "Migrations on deploy"). Each batch is one
> deployable, reversible PR. **Add the index** in the same migration — an
> unindexed `org_id` filter on `patients`/`messages` will dominate query
> plans.

### A3. Index & uniqueness review

- Composite-tenant the uniqueness constraints that are currently global
  (e.g. `patients.pacware_id`, message_template keys) → `(org_id, <key>)`,
  so two tenants can both have a "PacWare 123" without colliding.

---

## Workstream B — Tenant context in the request

### B1. Resolve `org_id` in auth middleware

- **File:** `artifacts/resupply-api/src/middlewares/requireAdmin.ts`.
- The `admin_users` lookup already runs here and already selects
  `role, location_id` (`requireAdmin.ts:144-150`). **Add `org_id` to that
  same select** and attach `req.orgId` next to `req.adminLocationId`
  (`:164`, `:229`). Zero extra round-trips.
- Extend the `Express.Request` augmentation block (`requireAdmin.ts:43-71`)
  with `orgId?: string`.
- **Fail closed:** mirror the existing P2-19 posture — a failed/empty
  `org_id` lookup rejects the request (401), exactly as the granular-role
  lookup does (`:151-174`). An admin with no org must never fall through to
  "see everything."

### B2. Resolve `org_id` for patient/customer + system contexts

- **File:** `artifacts/resupply-api/src/middlewares/requireSignedIn.ts` —
  derive `org_id` from the resolved `shop_customers` row (customers belong to
  an org).
- **Workers / jobs** (`artifacts/resupply-api/src/worker/**`) have no request.
  Each job item must carry its `org_id` in the pg-boss payload; the job
  handler sets the tenant context explicitly. Audit every
  `getSupabaseServiceRoleClient()` call in `src/worker/` during this step.
- **Public/unauthenticated** routes (storefront catalog, healthz) are
  org-resolved by **host** in Phase 3; in Phase 0 they stay on org #1.

---

## Workstream C — The scoped query wrapper (the chokepoint)

### C1. Build `getOrgScopedClient(orgId)`

- **New file:** `lib/resupply-db/src/org-scoped-client.ts`.
- Wraps `getSupabaseServiceRoleClient()` and returns a thin facade whose
  `.from(table)` automatically:
  - appends `.eq("org_id", orgId)` to every **select / update / delete**, and
  - injects `org_id: orgId` into every **insert** payload (rejecting a
    caller-supplied conflicting `org_id`).
- Maintain an allowlist of **non-tenant-scoped tables** (truly global:
  migration ledger, `organizations` itself, reference catalogs) that the
  wrapper passes through unscoped — explicit, reviewed, and small.
- Set the request-scoped DB GUC for RLS (Workstream D) on the same path so
  the two layers agree on the active tenant.

### C2. Route all data access through it

- Replace direct `getSupabaseServiceRoleClient()` calls in route/worker code
  with `req`-derived `getOrgScopedClient(req.orgId)`.
- This is mechanical but broad. Do it **per domain batch, paired with the A2
  migration** for that domain, so column + access land together and stay
  testable.
- `getSupabaseServiceRoleClient()` itself stays (migrator, the allowlisted
  global tables, and Workstream D need it).

---

## Workstream D — RLS backstop

### D1. Per-tenant policies — DONE

- **Migration `0344_org_isolation_rls_policies.sql`** adds a permissive
  `org_isolation` policy to every tenant-scoped table:
  `USING / WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid)`.
  It is a **catalog-driven `DO` loop** over `resupply` base tables that
  carry an `org_id` column (the same self-maintaining approach as 0170's
  RLS-enable loop), so it is correct by construction and idempotent
  (`DROP POLICY IF EXISTS` before `CREATE`).
- Because `service_role` (and `postgres`) bypass RLS, this **does not
  change runtime behavior** today — it is the backstop for the day any
  access moves to a non-bypassing role, and the BAA/SOC 2 evidence
  artifact. With the GUC unset, `current_setting(..., true)` is NULL so a
  non-bypass role still sees nothing (the post-0170 "RLS enabled" posture
  is preserved). Verified on a throwaway Postgres: bypass role sees all;
  non-bypass role sees only its tenant when the GUC is set and nothing
  when it is unset; `WITH CHECK` rejects cross-tenant writes.

### D2. GUC wiring (follow-up, not blocking)

- The wrapper (C1) will issue `SET LOCAL app.current_org_id = …` per
  request/txn so the policies bind to the active tenant. This is deferred
  until a non-bypassing role exists, since `service_role` ignores RLS —
  the app-layer wrapper remains the real isolation guarantee until then.
  (PostgREST has no per-statement `SET LOCAL`; this will ride a request
  header → `app.current_org_id` mapping or an RPC, tracked separately.)

---

## Workstream E — CI isolation guard (make the invariant enforceable)

### E1. New check script — DONE (ratchet mode)

- **File:** `scripts/check-tenant-isolation.sh`, in the spirit of the
  existing `scripts/check-resupply-architecture.sh` /
  `check-admin-route-gates.sh`.
- Fails the build when application code (outside `lib/resupply-db` and the
  reviewed allowlist) calls `getSupabaseServiceRoleClient()` directly instead
  of `getOrgScopedClient()` — the same pattern Rule 7 uses to forbid raw `pg`
  outside `lib/resupply-db`.
- **Ratchet, not big-bang.** Because ~390 files are still on the raw client
  mid-cutover, the guard runs against a committed baseline
  (`scripts/tenant-isolation-baseline.txt`). It **hard-fails on a new**
  offending file not in the baseline (the load-bearing protection), and
  emits a **non-fatal notice for a stale** baseline entry (a file already
  cut over or deleted). Stale is deliberately non-fatal: the cutover lands
  on `main` continuously and independently of any open PR, so a hard
  stale-fail would redden every in-flight PR the moment an unrelated
  cutover merged — and a stale entry never weakens isolation. The baseline
  only shrinks via `--update` (cutover PRs prune it). When it is empty the
  machinery is retired and the guard becomes a plain "no direct callsites"
  check — the PR 0.8 gate.
- **Wired in:** the CHECKS list in `scripts/run-resupply-checks.mjs` (so it
  runs under `pnpm verify`) and a dedicated `Tenant isolation guard` step in
  `.github/workflows/ci.yml` (self-test + check), alongside the other
  `check-*` self-tests. A fixture-driven `--self-test`
  (`check-tenant-isolation.sh.test`) proves the ratchet catches new/stale
  violations so the gate can't decay into a vacuous pass.

### E2. Cross-tenant leakage test

- **New test** (Vitest) seeding two orgs and asserting that a request scoped
  to org A cannot read/update/delete any org B row across a representative
  table from each domain batch. This is the regression net for the scariest
  failure mode.

---

## Suggested PR slicing

| PR      | Contents                                                                                                                        | Risk              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 0.1     | `organizations` table + seed org #1 + `getOrgScopedClient` skeleton (allowlist = everything, no-op) + CI guard in **warn** mode | Low               |
| 0.2     | `req.orgId` resolution in `requireAdmin` / `requireSignedIn` (attached, not yet enforced)                                       | Low               |
| 0.3–0.7 | Per-domain batches: A2 migration + C2 wrapper cutover + remove tables from the allowlist + RLS policy for that domain           | Medium (the bulk) |
| 0.8     | CI guard → **fail** mode; cross-tenant leakage test; worker payload `org_id` audit complete                                     | Gate              |

Each row is independently deployable and reversible. The system stays
single-tenant-correct (org #1 only) throughout — multi-tenant onboarding
doesn't begin until Phase 1+.

---

## Risks & mitigations

- **Cross-tenant PHI leakage** → the chokepoint wrapper (C) + RLS (D) + CI
  guard (E1) + leakage test (E2). Four independent layers.
- **A missed direct `getSupabaseServiceRoleClient()` call** → E1 turns this
  from a silent bug into a red build.
- **Backfill on ~100 tables** → domain batches, nullable→backfill→NOT NULL,
  each behind the existing migrate-on-deploy gate that keeps the prior
  release running on failure (CLAUDE.md).
- **Unindexed `org_id`** → index ships in the same A2 migration, never later.
- **Worker paths** (no `req`) silently running unscoped → explicit `org_id`
  in every pg-boss payload + the E1 guard covering `src/worker/`.

---

## Definition of done for Phase 0

1. `organizations` exists; existing data is org #1; no functional regression.
2. Every tenant-scoped table has a `NOT NULL`, indexed, FK'd `org_id`.
3. All application + worker data access flows through `getOrgScopedClient`.
4. RLS policies exist on every tenant-scoped table.
5. `check-tenant-isolation.sh` is in **fail** mode in CI and the pre-commit hook.
6. The cross-tenant leakage test passes and runs in CI.

When these hold, onboarding a second DME is a data operation (insert an
`organizations` row + bootstrap its first admin), and Phases 1–4 layer
per-tenant config, branding, billing, and routing on top.
