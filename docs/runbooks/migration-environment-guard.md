# Runbook — the migration environment guard

**Owner:** whoever holds the Railway project.
**Read this before:** creating a new Railway environment, rotating the
production database, or debugging a deploy that exited `3`.

---

## What happened, and what this prevents

A Railway **PR-preview environment** inherited the production service's
shared variables — `DATABASE_URL` among them — and its `preDeployCommand`
ran the migrator. A schema migration authored on an unmerged branch was
applied to the **production** database by a preview deploy. No person
decided that. Nothing in the repository could have stopped it, because the
only signal the migrator had was "`DATABASE_URL` is set".

Two properties make this recurrent rather than a one-off:

1. **Railway shared/project variables propagate into preview
   environments.** Any variable an operator sets to describe production is
   therefore also visible to a preview claiming to be production. A
   self-declared identity can never be trusted on its own.
2. **Railway does not inject `NODE_ENV`.** The historical "is this
   production?" test was false on _every_ Railway container, production
   included.

The guard (`lib/resupply-db/scripts/deploy-environment.mjs`) closes this by
resolving **two independent identities** and refusing when they do not
agree.

---

## The rule

> **A deployment that is not production may not migrate a database that is
> not positively non-production.**

| Deployment           | Database                                     | Result                                                       |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| production           | production                                   | **allowed**                                                  |
| production           | preview / staging / dev                      | allowed                                                      |
| production           | _undeclared_                                 | allowed, with a loud warning naming the variable to set      |
| preview / PR         | production                                   | **blocked** (`nonproduction_deployment_production_database`) |
| preview / PR         | preview (declared or fingerprint-mismatched) | allowed                                                      |
| preview / PR         | _undeclared_                                 | **blocked** (`ambiguous_database_identity`)                  |
| local / test         | production                                   | **blocked** (break-glass only)                               |
| local / test         | loopback                                     | allowed                                                      |
| _ambiguous identity_ | anything                                     | **blocked** (`ambiguous_deployment_identity`)                |

A blocked run exits **3**, distinct from `1` (a migration failed) and `2`
(`DATABASE_URL` unset), so a deploy log can be triaged without reading it.
Nothing is executed and **no connection is opened** to the database.

Because Railway's `preDeployCommand` **gates** the deploy, a refusal keeps
the **previous release serving**. A blocked preview is an inconvenience; it
is never an outage.

---

## How each identity is resolved

### Deployment — _what is running_

| Source                     | Inheritable?             | Used for                 |
| -------------------------- | ------------------------ | ------------------------ |
| `DEPLOY_ENV`               | **yes**                  | the explicit declaration |
| `RAILWAY_ENVIRONMENT_NAME` | no — set per environment | corroboration            |
| `RAILWAY_GIT_BRANCH`       | no — set per deployment  | corroboration            |

A PR-shaped environment name (`PennFit-pr-1366`, `pr-42`, anything
containing `preview`) means **preview**. A deploy from any branch other
than `PRODUCTION_GIT_BRANCH` (default `main`) means **not production**.

**A `DEPLOY_ENV=production` that the non-inheritable markers deny is a
conflict, and a conflict blocks.** That is precisely the incident's shape:
the preview inherited `production` and Railway's own variables said
otherwise.

With no platform markers at all and no `DEPLOY_ENV`, the process is a
developer's shell — `development` (or `test` under `NODE_ENV=test`). Local
work and CI are unaffected.

### Database — _what it is pointed at_

`PRODUCTION_DATABASE_FINGERPRINT` pins production by a **salted digest of
`host:port/dbname`**. Credentials and query parameters are excluded, so a
password rotation does not change it and no secret reaches the digest.

Precedence:

1. **Fingerprint match → production.** Authoritative; overrides a
   `DATABASE_ENV` that disagrees. A preview cannot talk its way out of the
   database it is actually holding.
2. **A pin exists and this is not it → positively non-production.** This is
   what lets a preview with its own database migrate freely.
3. `DATABASE_ENV` — the operator's declaration.
4. A loopback / container-local host → development.
5. Otherwise **undeclared**, which blocks any non-production deployment.

Fingerprint the database you are holding:

```bash
node -e 'import("./lib/resupply-db/scripts/deploy-environment.mjs").then(m=>console.log(m.fingerprintDatabaseUrl(process.env.DATABASE_URL).fingerprint))'
```

Nothing but the 12-character digest is ever printed, logged, or thrown.

---

## Railway variables to configure

### On the **production** service — set explicitly, do **not** share

| Variable            | Value        |
| ------------------- | ------------ |
| `DEPLOY_ENV`        | `production` |
| `RUN_DB_MIGRATIONS` | `true`       |

### As **shared/project** variables — these are _meant_ to reach every environment

They are what lets a preview recognise production and refuse it, so
inheritance is the point.

| Variable                          | Value                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRODUCTION_DATABASE_FINGERPRINT` | digest of the production `DATABASE_URL` (comma-separated if the database has more than one host spelling — pooled vs direct, pgbouncer vs primary) |
| `PRODUCTION_SUPABASE_FINGERPRINT` | digest of the production `SUPABASE_URL`                                                                                                            |
| `PRODUCTION_GIT_BRANCH`           | only if the trunk is not `main`                                                                                                                    |

### On every **preview / PR / staging** environment

| Variable            | Value                                                          |
| ------------------- | -------------------------------------------------------------- |
| `DEPLOY_ENV`        | `preview` (or `staging`)                                       |
| `DATABASE_ENV`      | `preview` — required if that environment should run migrations |
| `RUN_DB_MIGRATIONS` | `false`, unless the environment has its **own** database       |

> **`DEPLOY_ENV` must be set per environment, never shared.** A shared
> `DEPLOY_ENV=production` is the exact variable that leaked. The guard now
> catches it, but the deploy still fails until it is fixed.

---

## Two guards, deliberately asymmetric

|                                | Migration guard                     | Runtime data-path guard                                      |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------ |
| Where                          | `deploy-migrate.mjs`, `migrate.mjs` | `artifacts/resupply-api/src/lib/data-path-guard.ts`, at boot |
| Protects                       | production's **schema**             | production's **rows** (PHI)                                  |
| On a positive cross-tier match | refuses (exit 3)                    | refuses to boot                                              |
| On ambiguity                   | **refuses**                         | **warns**, boots                                             |

The asymmetry is intentional. A refused `preDeployCommand` leaves the
previous release serving, so a false positive costs a deploy. A refused
**boot** has no such fallback on a first deploy, and taking production dark
over an unset variable is worse than the thing being prevented — so the
boot guard fires only on an unambiguous violation.

The runtime guard also covers `SUPABASE_URL`, which is the _actual_ runtime
data path. A preview that inherited `SUPABASE_URL` + the service-role key
can read and write production PHI **without applying a single migration**.

---

## Break-glass

Off by default. Two variables, both required:

```bash
DANGEROUSLY_ALLOW_PRODUCTION_DB_MIGRATION_FROM_NONPRODUCTION=I-UNDERSTAND-THIS-WRITES-TO-PRODUCTION
MIGRATION_BREAK_GLASS_REASON="INC-1234 — restoring the index dropped at 14:02"
```

- The phrase must match **exactly**. `true` / `1` / `yes` do not work.
- The reason must be **≥ 20 characters**. Break-glass is never anonymous.
- It unlocks **only** `nonproduction_deployment_production_database`. It
  cannot paper over an ambiguous identity — fix the identity instead, which
  is a one-variable change.
- It emits a banner plus a machine-readable
  `{"event":"migration.guard.break_glass", …}` line for alerting.

**Remove both variables from the environment immediately afterwards.**
`preflight:prod` **fails** while either is present.

---

## Triage — a deploy exited 3

Read the JSON line in the deploy log:

```json
{
  "event": "migration.guard.blocked",
  "code": "…",
  "deploymentTier": "…",
  "databaseTier": "…",
  "databaseFingerprint": "…"
}
```

| `code`                                         | Meaning                                                                     | Fix                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ambiguous_deployment_identity`                | `DEPLOY_ENV` is unset, misspelled, or contradicted by Railway's own markers | Set `DEPLOY_ENV` on **this** environment. If it says `production` in a PR environment, a shared variable has leaked — unshare it. |
| `ambiguous_database_identity`                  | Non-production deployment, undeclared database                              | Set `DATABASE_ENV` on this environment, or set `PRODUCTION_DATABASE_FINGERPRINT` as a shared variable so a non-match proves it.   |
| `nonproduction_deployment_production_database` | **The incident.** A preview is holding production's `DATABASE_URL`.         | Point the environment at its own database. Do **not** reach for break-glass.                                                      |

The correct response to the third row is almost never "override it".

---

## Verification

The whole matrix is covered by automated tests; nothing here needs a live
database:

```bash
pnpm --filter @workspace/resupply-db test   # decision matrix + spawn-the-real-script wiring
pnpm --filter @workspace/resupply-api exec vitest run src/lib/data-path-guard.test.ts
pnpm --filter @workspace/scripts test       # preflight variable checks
```

Before a production deploy:

```bash
pnpm --filter @workspace/scripts preflight:prod
```

which **fails** when `DEPLOY_ENV` / `PRODUCTION_DATABASE_FINGERPRINT` /
`PRODUCTION_SUPABASE_FINGERPRINT` are missing in `NODE_ENV=production`, or
when break-glass is left armed.

It also **fails when a pin does not list the database or Supabase project
this environment is actually using.** That check is not tidiness: a
non-match is load-bearing negative evidence. `resolveDatabaseIdentity`
reads "this fingerprint is not in the pin" as proof the database is a
_preview_ database — which is exactly what lets a preview with its own
database migrate freely. So an incomplete pin recreates the whole
incident: a preview that inherited production's `DATABASE_URL`
fingerprints as something absent from the pin, is classified
non-production, and is allowed to migrate production.

Running preflight **against production** is the only thing that can prove
the pin covers what production really uses. If a pooled and a direct host
both appear in normal operation, list **both** in the comma-separated pin
— that is what the comma is for. Do not resolve a mismatch by removing the
check.

---

## Related

- [`adopt-migration-ledger.md`](./adopt-migration-ledger.md) — the one-time
  baseline, already completed for production (verified 2026-06-06).
- [`../railway-deployment.md`](../railway-deployment.md) — how Railway
  builds and runs the repo.
- [`production-launch.md`](./production-launch.md) — first-launch order of
  operations.
