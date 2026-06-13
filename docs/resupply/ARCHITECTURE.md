# CPAP Resupply Automation Architecture

This document describes the current resupply system layout, data flow, and
package-boundary rules. The "why" for major choices lives in
`docs/resupply/adr/`; this file is the day-to-day map.

## Top-Level Shape

```text
artifacts/
  resupply-api/       Single Express API process. Hosts storefront/fitter
                      routes at /api/*, admin/resupply routes at
                      /resupply-api/*, voice/webhook endpoints, and the
                      in-process pg-boss worker booted from src/worker/.
  cpap-fitter/        Customer-facing Vite + React SPA. Also mounts the
                      internal admin console at /admin/*. Legacy /resupply/*
                      URLs redirect to /admin/* with query strings preserved.
  shared/             Shared static assets, currently the root favicon set.

lib/
  resupply-db/        Supabase service-role client, generated PostgREST row
                      types, migration tooling, and the shrinking direct-pg
                      compatibility surface.
  resupply-auth/      In-house admin auth: argon2id passwords, DB-backed
                      sessions, invite/reset/verify token flows.
  resupply-auth-react/
                      Admin auth hooks used by the SPA.
  resupply-domain/    Pure business logic and domain helpers.
  resupply-messaging/ Pure keyword, link-token, and email-template semantics.
  resupply-email/     SendGrid adapter.
  resupply-telecom/   Twilio/Telnyx telephony and SMS adapter layer.
  resupply-ai/        OpenAI Realtime adapter and conversation/tool schemas.
  resupply-reminders/ Shared outbound-reminder orchestration used by API
                      routes and worker jobs.
  resupply-integrations*/
                      Partner connectivity contracts and vendor adapters
                      for therapy-cloud pulls, payer/claims, inbound order
                      webhooks, and Pacware exchange.
  resupply-templates/ Shared document/template helpers.
  resupply-secrets/   Secret-loading helpers.
  resupply-audit/     No-op compatibility shim for historical callsites.
                      Compliance evidence is handled out of band by the
                      business owner.
  api-client-react/   Hand-maintained storefront/admin API client and React
                      hooks consumed by cpap-fitter.

scripts/              Architecture, migration, admin-route, deploy, and
                      operator utilities.
e2e/                  Playwright smoke, accessibility, and resilience specs.
docs/resupply/        This file plus ADRs.
```

The former `artifacts/api-server`, `artifacts/resupply-worker`, and
`artifacts/resupply-dashboard` processes were folded into the two current
artifacts during the May 2026 consolidation. The former
`lib/resupply-contracts` and `lib/resupply-testing` packages were deleted.

## Runtime Flow

```text
Browser
  |
  | HTTPS, pf_session cookie, signed patient links
  v
artifacts/cpap-fitter
  |
  | /api/* and /resupply-api/*
  v
artifacts/resupply-api
  |
  | Supabase service-role client
  v
Postgres / Supabase

artifacts/resupply-api
  |
  | pg-boss enqueue/dequeue, in process
  v
worker jobs in artifacts/resupply-api/src/worker/
  |
  | shared lib adapters
  v
SendGrid, Twilio/Telnyx, Stripe, OpenAI, partner integrations
```

Pacware remains the inventory system of record. PennFit tracks the
patient-facing side of resupply episodes, fulfillment intent, tracking echoes,
partner snapshots, and admin workflow state. It does not own on-hand inventory,
lots, serial numbers, purchase orders, receiving, transfers, or warehouses.

## Dependency Boundaries

`scripts/check-resupply-architecture.sh` is the enforcement point. The rules
below summarize the current intent; if a change needs to cross one of these
boundaries, write an ADR first.

- `lib/resupply-domain` stays pure. It must not import DB, telecom, AI, audit,
  raw `pg`, Drizzle, or vendor SDK packages.
- `lib/resupply-db` owns Postgres connectivity. Runtime application code should
  use `getSupabaseServiceRoleClient()`; direct `pg` access is limited to
  migration tooling and a small number of legacy pool-level worker paths exposed
  through `getDbPool()`.
- `lib/resupply-db` must not import telecom or AI adapters.
- `lib/resupply-ai`, `lib/resupply-telecom`, `lib/resupply-email`, and
  `lib/resupply-messaging` stay adapter/semantic layers. They do not reach into
  unrelated vendor SDKs or the DB layer.
- `lib/resupply-reminders` may compose DB, telecom, email, messaging, and audit
  dependencies because it is the shared reminder orchestration layer, but it
  must not import vendor SDKs directly.
- `lib/resupply-integrations*` packages are pure connectivity contracts and
  adapters. They return normalized values; persistence belongs in the
  resupply-api route/registry layer.
- `@workspace/api-client-react` is for `artifacts/cpap-fitter` only. Resupply
  libraries and the Express server must not import the React client.
- No package should add new Drizzle runtime dependencies. Drizzle tooling was
  retired; SQL migrations are hand-written.
- No production code should add direct `audit_log` writers or new audit-log
  readers. The historical `@workspace/resupply-audit` package is a no-op
  compatibility shim, and compliance evidence is handled out of band.
- Worker jobs must create pg-boss queues through `createQueueWithDlq()` so
  queue dead-letter rows exist before main queues reference them.
- Schema and migration changes must preserve the Pacware inventory boundary:
  no PennFit-owned inventory, lot, receiving, warehouse, purchase-order, or
  stock-transfer tables without an ADR.

## Schema And Migrations

- Resupply tables primarily live under `resupply.*`; storefront/fitter support
  tables live under `public.*`; pg-boss tables live under `pgboss_resupply`.
- PHI columns are plaintext `text`/`jsonb`. Migration
  `0025_strip_phi_encryption.sql` removed the prior pgcrypto column-level
  encryption and related key material.
- SQL migrations live in `lib/resupply-db/drizzle/`. The directory and
  `drizzle.resupply_migrations` table keep historical names for compatibility,
  but new migrations are hand-written SQL.
- `lib/resupply-db/scripts/migrate.mjs` applies every SQL file in numeric
  prefix order, deduping by SHA256 content hash. Do not edit, rename, delete,
  or renumber migrations that exist on `main`; add a new corrective migration.
- `lib/resupply-db/drizzle/meta/_journal.json` is frozen. It is read only to
  recover historical `created_at` timestamps for old files.

See `lib/resupply-db/README.md`, `lib/resupply-db/drizzle/README.md`, and
`docs/migration-state-investigation-2026-05-08.md` before changing migrations.

## Auth Model

- Admins authenticate through `lib/resupply-auth`.
- Passwords are argon2id hashes. The historical process-wide password pepper
  has been removed.
- Admin sessions are DB-backed sliding sessions.
- Admin access checks combine DB membership with the
  `RESUPPLY_ADMIN_EMAILS` allowlist.
- Patients do not have admin accounts. Patient-facing workflows use signed
  short-lived links delivered by SMS or email, plus device/session tokens.

## Observability And Compliance

- The API and in-process worker emit Pino structured logs to stdout.
- Railway logs are the primary runtime sink today.
- `/healthz` is liveness only and does not touch dependencies.
- `/readyz` probes Postgres and pg-boss readiness, returns structured 503s on
  dependency failure, rate-limits public callers, and briefly caches snapshots
  to avoid turning external probes into DB load.
- The in-app compliance/audit machinery has been retired. Do not add new
  audit-log readers or writers; route-specific degraded responses are the
  current pattern where historical audit data is unavailable.

## Local Development

```bash
pnpm install
bash scripts/install-hooks.sh
cp .env.example .env

pnpm typecheck
pnpm build
pnpm test

pnpm --filter @workspace/resupply-api dev
pnpm --filter @workspace/cpap-fitter dev

bash scripts/check-resupply-architecture.sh
scripts/check-admin-route-gates.sh
pnpm verify
```

The repo targets Node 24 and pnpm 11.5.2. `artifacts/resupply-api` and
`artifacts/cpap-fitter` should run on distinct local ports; Railway injects
`PORT` in production and defaults `BASE_PATH` to `/`.

## Current Operating Status

The system is no longer Phase 0 scaffolding. The current production shape is a
single Railway-deployed Express process plus one Vite SPA, with the worker
running in process. New work should preserve that consolidation unless an ADR
explicitly reopens the deployment topology.
