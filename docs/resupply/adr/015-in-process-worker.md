# ADR 015 — In-process pg-boss worker (consolidation, May 2026)

## Context

Earlier phases of resupply-api ran the queue worker as a separate
artifact (`artifacts/resupply-worker`) with its own `artifact.toml`,
build pipeline, healthz server, deploy gate, and workflow. The split
followed the original (AWS-shaped) design, where the worker would
eventually want crash isolation from the request-serving API and its
own scaling axis.

The actual workload that landed turned out to be tiny:
* `reminders.scan` — hourly outreach evaluator.
* `prescription-attachment-sweep` — weekly orphan reaper.
* `smart-trigger-evaluator` / `-send` — daily.
* `rx-renewal-send` — daily.
* `idempotency-keys-prune` — daily.
* `onboarding-checkins.*` — daily.

All of those are quiet (sub-second handlers, kicked by pg-boss
schedules). The split process bought no measured isolation — it was
talking to the same Postgres the API talks to anyway — but cost an
entire artifact (deploy, monitor, healthz pair, build pipeline) to
keep that pretense.

The API's existing `/readyz` check already probed
`pgboss_resupply.version` regardless of which process called
`boss.start()`, so colocation was always anticipated.

## Decision

Run pg-boss inside the resupply-api process. Keep the in-process
worker behind a clean module boundary
(`artifacts/resupply-api/src/worker/index.ts`) so a future split
back out is contained.

Concretely:
* `startWorker()` is invoked from `index.ts` after the HTTP server
  binds. Failure to start the worker takes the whole process down.
* Every job handler is registered idempotently (pg-boss's
  `createQueue` + `schedule` are upsert-style).
* Shutdown is one signal handler that gracefully stops both the
  HTTP server and pg-boss.
* The `/readyz` check still gates traffic on the
  `pgboss_resupply.version` row, so a crash in `boss.start()`
  doesn't accept traffic that depends on the queue.

## Consequences

Positive:
* One artifact to deploy, one set of logs, one set of secrets.
* Worker code can directly `import { logAudit } from
  "@workspace/resupply-audit"` without an HTTP RPC.
* `pgboss_resupply` schema and `drizzle.resupply_migrations`
  migrate together — no two-step deploy.

Negative:
* A long-running web request handler can starve job handlers
  inside the same Node event loop. Today every handler is short
  enough that this is theoretical; the moment it isn't, that's the
  signal to split out.
* A boot-time crash in any cron-scheduling code (e.g. a malformed
  `boss.schedule(...)` call) takes the whole API down. Mitigation:
  schedule registration is wrapped in
  `registerXxxJob(boss)` helpers that throw at module import only
  for actual misconfiguration; the runtime jobs fail soft into
  pg-boss's retry-then-archive flow.

## Re-architecting hints

If the workload ever stops being quiet, the right path is:
1. Re-extract `artifacts/resupply-api/src/worker/` back into its
   own artifact (`artifacts/resupply-worker`).
2. Keep `pgboss_resupply` schema / `boss.start()` semantics
   identical so `/readyz` stops requiring change.
3. Redirect `worker/jobs/*` registrations from the API to the
   re-extracted worker process; leave the dispatcher routes
   (`/admin/.../send-due`) on the API since they're operator-
   triggered.

The `artifacts/resupply-api/src/worker/index.ts` module header
documents this pivot path so the next maintainer doesn't need to
re-derive it.

## Operational visibility

`monitor-states` is enabled with a 10-minute interval. The worker
emits a structured `WARN` when any queue carries non-zero
`failed`/`retry` counts (`event=pg_boss_jobs_unhealthy`) and stays
silent otherwise. See `docs/resupply/RUNBOOK-worker.md` for the
full alert posture and triage procedures.

## Related ADRs

* ADR 002 — pg-boss for v1, with a migration path to Temporal.
* ADR 010 — No Docker, no Redis (the original argument for keeping
  infra Postgres-only).
