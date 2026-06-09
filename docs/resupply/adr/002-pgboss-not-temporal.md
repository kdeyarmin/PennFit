# ADR 002 — pg-boss for v1, with a documented migration path to Temporal

## Context

The original plan called for Temporal as the durable workflow engine for
multi-day, multi-channel outreach orchestration (e.g. supply-due nudges
spanning a week with SMS, voice, and email steps).

Temporal requires running its own server cluster (Cassandra/MySQL/Postgres
backend, history service, matching service, frontend service, workers).
That is awkward to host on a single Railway service; the realistic options
are Temporal Cloud (paid) or a self-hosted cluster on a
real cloud.

For Phase 0 we need a durable job substrate that:

- Survives process restarts (job state persisted to Postgres).
- Supports retries with exponential backoff.
- Supports scheduled/delayed jobs (next nudge at T+3 days).
- Can be replaced later without rewriting the workflows themselves.

## Decision

Use **pg-boss** as the queue and scheduler. Express the multi-day outreach
workflows as small explicit state machines persisted in Postgres
(`outreach_workflows` table) where each step enqueues a pg-boss job for the
next step.

- Queue + scheduler: pg-boss (Postgres-backed; no Redis, no Temporal server).
- Workflow state: a Drizzle table per workflow type (e.g. `resupply_outreach`)
  with explicit columns for `current_state`, `next_run_at`, `attempt_count`,
  `last_error`. pg-boss jobs are step executors; the table is the source of
  truth for "what state are we in".
- Worker: `artifacts/resupply-worker` boots a pg-boss instance, registers
  handlers for each step, and stays alive.

Workflow code is structured so that swapping pg-boss for Temporal at
production migration time is a mechanical job — handlers become Temporal
activities, the state-machine table becomes implicit Temporal history.

## Consequences

- One fewer service to host. Postgres alone covers durability.
- We give up Temporal's free goodies: workflow visibility UI, child
  workflows, signals, queries, automatic versioning of workflow code,
  side-effect detection. We replace these with: structured logs, an
  admin-dashboard view onto the workflow table, and a strict rule that
  workflow steps must be idempotent (since pg-boss can re-run a step on
  retry without rolling back side effects).
- The "step must be idempotent" rule is tested explicitly in
  `lib/resupply-domain` for every step — if we lose that discipline, the
  abstraction leaks.

## Migration trigger

Move to Temporal when **any** of these become true:

- Workflows have more than ~10 steps and the state machine becomes hard to
  reason about.
- We need durable signals from admins (e.g. "pause this patient's
  outreach mid-flight") and the ad-hoc table updates feel fragile.
- We need workflow versioning because deploys change step semantics
  mid-flight.

## Alternatives Considered

- **Temporal dev server in a workflow** — rejected; the dev server is not
  meant for production and there is no clean Railway production target for
  the cluster.
- **BullMQ + Redis** — rejected; would require a managed Redis (an extra
  vendor dependency) when pg-boss covers the same ground using the DB
  we already need.
- **node-cron + ad-hoc scheduling** — rejected; no durability, no retry,
  no fan-out.

## TODO (business)

- [BUSINESS REVIEW] Decide whether multi-day workflow visibility (a
  Temporal-style UI) is a launch requirement or a v2 feature.
