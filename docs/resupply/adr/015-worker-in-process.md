# ADR 015 — Worker consolidated in-process with the API

## Context

ADR 002 chose pg-boss as the queue + scheduler and described a
separate `artifacts/resupply-worker` artifact that boots a pg-boss
instance and registers job handlers. The split was justified at the
time by crash isolation — a wedged job handler should not take down
the API serving live requests.

In practice the workload turned out to be overwhelmingly quiet: an
hourly reminder scan, a weekly attachment sweep, a daily idempotency-
keys prune, and four daily dispatchers (smart-trigger evaluator,
smart-trigger send, Rx-renewal send, onboarding check-ins). Total
work hours per day across all crons: well under one. The "isolation"
the split bought was theoretical; what it actually cost was visible:

- A second artifact (its own `artifact.toml`, build pipeline,
  `/healthz` server, deploy gate, workflow registration).
- A second process to monitor and page on (and the on-call only saw
  a problem when both processes' alerts correlated).
- A duplicate Postgres connection pool (the worker connects via
  `getDbPool()` exactly the same way the API does).
- A coordination problem at deploy: the API's `/readyz` probe checks
  `pgboss_resupply.version` to gate traffic, so the API was always
  implicitly waiting on the worker to have started.

The original split was the right hedge for an unknown workload; it's
the wrong choice for a known-quiet one.

## Decision

Boot pg-boss inside the API process. `artifacts/resupply-worker` was
deleted; `artifacts/resupply-api/src/worker/index.ts` exposes
`startWorker()` / `stopWorker()` / `isWorkerReady()` and is invoked
from the API's startup sequence after the Express app is built.

- One process. One workflow. One deploy gate.
- The same `/readyz` probe still checks `pgboss_resupply.version` —
  the schema is created by `boss.start()` regardless of which process
  calls it, so no behavioural change for the readiness contract.
- One shutdown handler covers both the HTTP server and pg-boss.
- Failed-job alerting (P1.2 in
  `docs/codebase-enhancements-2026-05-08.md`) lives on the same
  pg-boss instance, so the warn-on-delta closure in
  `worker/index.ts` shares scope with the API's `logger` instance —
  no IPC required.

## Consequences

- A wedged job handler that pegs CPU CAN now affect API latency. The
  mitigation is the discipline already required by ADR 002 ("workflow
  steps must be idempotent") plus pg-boss's per-handler concurrency
  caps. If a workload genuinely needs CPU isolation, see "Migration
  trigger" below.
- A misconfigured pg-boss (e.g. `DATABASE_URL` pointing at the wrong
  schema, `pgboss_resupply.version` migration mismatch) crashes the
  API at boot rather than silently failing in a sidecar. This is a
  net win: the misconfig surfaces at the deploy gate instead of
  showing up hours later when the first cron tries to fire.
- Scaling out the API horizontally now means either: (a) running the
  worker on every replica (pg-boss handles concurrent workers via
  `__state__` locks; this works correctly today), or (b) gating
  worker startup to one replica via a leader-election pattern. Today
  we run a single API replica so neither pattern is exercised; if we
  ever scale out, pick one explicitly before deploying.

## Migration trigger

Re-extract the worker into its own process when **any** of these
become true:

- A workload genuinely needs CPU isolation — high-frequency call-
  queue processing, embedding generation for a per-message ML
  pipeline, anything that would be blocked by Node's single thread.
- We add a workload that should run on a different deploy cadence
  than the API (e.g. an offline ETL that updates schema in ways the
  serving API hasn't been deployed against yet).
- Horizontal scaling reaches a point where every-replica-runs-worker
  burns meaningful redundant DB work, AND leader-election
  coordination is harder than just splitting the process.

The re-extraction is a contained change: re-create
`artifacts/resupply-worker`, copy the directory contents, restore
the `artifact.toml` and per-process boot, and remove the
`startWorker()` call from the API boot path. The pg-boss schema
stays the same.

## Alternatives Considered

- **Keep the split and pay the cost.** Rejected; the cost is real
  (deploy coordination, two alert channels, two healthchecks) and
  the benefit (CPU isolation for a workload that isn't CPU-bound)
  is theoretical.
- **Move every cron to an external scheduler (cloud cron, k8s
  CronJob).** Rejected; the workflows aren't just "run this command
  on a schedule" — they have shared state machines persisted to
  Postgres tables that the API also reads. Splitting them out
  fragments the model.
- **Use Node `worker_threads` for CPU-isolating individual
  handlers.** Premature. The handlers don't need it today; revisit
  if a specific workload changes that.

## Related

- `artifacts/resupply-api/src/worker/index.ts` — the boot sequence,
  monitor-states alerting, and shutdown handler.
- `artifacts/resupply-api/src/lib/readiness.ts` — the `/readyz`
  probe that asserts the pg-boss schema.
- `docs/runbooks/worker-recovery.md` — operational playbook when
  failed-job alerts fire.
- ADR 002 (pg-boss not Temporal) — the original choice; this ADR
  refines its packaging.
