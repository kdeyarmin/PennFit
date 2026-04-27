# CPAP Resupply Automation — Architecture

This document describes how the resupply system is laid out in this monorepo,
how data flows between the pieces, and the dependency rules every package
must obey. The "why" for each major choice lives in `docs/resupply/adr/`.

## Top-level shape

```
artifacts/
  resupply-api/         Express + Zod HTTP API (Clerk-protected)
  resupply-worker/      pg-boss background worker (durable jobs)
  resupply-dashboard/   React + Vite operator console (Clerk auth)
lib/
  resupply-contracts/   Zod schemas + DTOs (shared over the wire)
  resupply-domain/      Pure business logic — no I/O
  resupply-db/          Drizzle schema + connection
  resupply-audit/       Append-only audit logger + helpers
  resupply-telecom/     Twilio (SMS, Voice) + SendGrid (Email) adapters
  resupply-ai/          Anthropic Claude adapter for the conversation agent
  resupply-testing/     Fixtures, factories, mock vendors (devDeps only)
docs/resupply/
  ARCHITECTURE.md       This file.
  adr/                  Architectural Decision Records (000–012).
```

The Penn Fit product (`artifacts/api-server`, `artifacts/cpap-fitter`,
`artifacts/penn-fit-tutorial`) is a separate product and shares only
`lib/db`'s connection pool. The two products' tables live in different
Postgres schemas — Penn Fit in `public.*`, resupply in `resupply.*`.

## Data flow (Phase 0 baseline)

Phase 0 is scaffolding only. The data flow below is what the system is
**designed for**; only the dotted edges (HTTP between dashboard, api, and
worker; pg-boss enqueue/dequeue; DB reads/writes through Drizzle) actually
move bytes today.

```
                     ┌────────────────────────────┐
                     │  resupply-dashboard (web)  │
                     │  React + Vite + Clerk      │
                     └──────────────┬─────────────┘
                                    │ HTTPS (Clerk JWT)
                                    ▼
                     ┌────────────────────────────┐
                     │  resupply-api (Express)    │
                     │  /resupply-api/*           │
                     └──┬─────────────────┬───────┘
                        │ Drizzle         │ pg-boss enqueue
                        ▼                 ▼
                 ┌──────────────┐  ┌─────────────────┐
                 │ Postgres     │  │ resupply-worker │
                 │ resupply.*   │◄─┤ pg-boss handlers│
                 │ pgboss_resupply.* │ Twilio / SendGrid /
                 └──────────────┘  │ Anthropic       │
                                   └─────────────────┘
                                            │
                                            ▼
                                   patient SMS / voice / email
```

Pacware integration (the legacy DME system of record) is **not** wired into
this diagram because it is a manual CSV exchange handled through the
dashboard — see ADR 009.

## Dependency rules

The whole point of the lib split is that each layer can be reasoned about
in isolation. The rules below are enforced by `scripts/check-resupply-architecture.sh`
which runs as part of the `resupply-check` validation step.

### Allowed dependency edges

| Package                  | May import from                                                                  |
|--------------------------|----------------------------------------------------------------------------------|
| `resupply-contracts`     | `zod` only                                                                       |
| `resupply-domain`        | `resupply-contracts`, `zod`                                                      |
| `resupply-db`            | `resupply-contracts`, `resupply-domain`, `drizzle-orm`, `pg`, `zod`              |
| `resupply-audit`         | `resupply-contracts`, `resupply-db`, `drizzle-orm`, `zod`                        |
| `resupply-telecom`       | `resupply-contracts`, `resupply-domain`, `zod` (vendor SDKs added in Phase 3)    |
| `resupply-ai`            | `resupply-contracts`, `resupply-domain`, `zod` (Anthropic SDK added in Phase 6)  |
| `resupply-testing`       | `resupply-contracts`, `resupply-domain`, faker, `zod` — **devDeps only**         |
| `artifacts/resupply-api` | any `lib/resupply-*` package + Express stack                                     |
| `artifacts/resupply-worker` | any `lib/resupply-*` package + `pg-boss`                                      |
| `artifacts/resupply-dashboard` | any `lib/resupply-*` package + React stack (no `resupply-db` at runtime)   |

### Forbidden edges (these will fail the check script)

- `resupply-domain` → `resupply-db`. Domain logic must be testable without
  a database.
- `resupply-domain` → `resupply-telecom` / `resupply-ai`. Same reason.
- `resupply-contracts` → anything except `zod`. It is the dependency root.
- `resupply-db` → `resupply-telecom` / `resupply-ai`. The DB layer does not
  call vendors.
- `resupply-telecom` ↔ `resupply-ai`. Channels do not import each other;
  if they need to share something, factor it into `resupply-domain`.
- Any production code → `resupply-testing`. Testing utilities are devDeps
  in every consumer.
- Any resupply package → Penn Fit's `lib/db` or `lib/api-zod`. These are
  separate products.

### Temporary exceptions (must be removed before the phase listed)

- `artifacts/resupply-dashboard` is permitted to depend on
  `@workspace/api-client-react` while it is still the unmodified Vite
  scaffold. This is a Penn Fit package and would normally be forbidden
  by the rule above. The exception goes away in **Phase 4**, when the
  dashboard is rewritten against a resupply-specific generated client
  (`@workspace/resupply-api-client`). The architecture-check script
  carves out this single edge by not including the dashboard's `src/`
  in the Penn-Fit-import sweep; everything else still trips the gate.

## Schema and encryption

- All resupply tables live in the Postgres `resupply` schema (created by
  the first migration in Phase 1). pg-boss tables live in `pgboss_resupply`.
- Encrypted columns use the `encryptedText()` / `encryptedJson()` Drizzle
  helpers from `lib/resupply-db`, backed by pgcrypto + `RESUPPLY_DATA_KEY`
  in dev. See ADR 007 for the migration path to managed KMS before launch.

## Auth model

- Operators authenticate via Clerk (ADR 005). The api enforces a
  `requireOperator` middleware that checks the operator allowlist
  (`RESUPPLY_OPERATOR_EMAILS` env var, comma-separated).
- Patients do NOT have Clerk accounts. Patient-facing endpoints use
  short-lived signed links delivered via SMS or email, plus device-side
  session tokens. Patient auth lands in Phase 10.

## Observability

- Pino structured logs to stdout from both the api and the worker.
  Replit's log viewer is the only sink in Phase 0.
- Sentry (BAA tier) is added before Phase 9 production hardening (ADR 010).
- The `admin_audit_log`-style append-only audit table for the resupply
  product lives in `lib/resupply-audit`'s schema. Every PHI read or write
  by an operator writes one row.

## How to run locally

```
# Install everything once
pnpm install

# Start everything (one workflow per service):
#   - artifacts/resupply-api: API Server      (auto-started)
#   - artifacts/resupply-dashboard: web       (auto-started)
#   - Resupply Worker                          (started on demand)

# Run the architecture / lint / typecheck / test gate:
bash scripts/check-resupply-architecture.sh
pnpm -r --filter "@workspace/resupply-*" run typecheck
pnpm -r --filter "@workspace/resupply-*" run test
```

## Phase 0 status

Phase 0 ships scaffolding only. Specifically:

- Seven `lib/resupply-*` packages exist with composite TS configs and
  empty `src/index.ts` bodies.
- `artifacts/resupply-api` boots and answers `GET /resupply-api/healthz`
  with `{"status":"ok","service":"resupply-api"}`.
- `artifacts/resupply-worker` connects to pg-boss against `DATABASE_URL`,
  logs `resupply-worker ready`, and stays alive.
- `artifacts/resupply-dashboard` is a default React + Vite scaffold at
  `/resupply/`. Real pages land in Phase 4+.
- The architecture-check script verifies the dependency rules above.

Any business logic, schema, real vendor wiring, or operator UI is
explicitly **out of scope** for Phase 0 and will be addressed in
subsequent phases (1 through 12) of the plan.
