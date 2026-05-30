# Worker Recovery Runbook

Covers the in-process pg-boss worker booted from
`artifacts/resupply-api/src/worker/index.ts`. All jobs run as crons
inside the same process as the API; there is no separate worker
artifact (see `README.md` and the header comment in `worker/index.ts`
for why).

This runbook is the playbook for the alert that fires when a job hits
the terminal `failed` state (P1.2: `event: "pgboss_jobs_failed"`).

---

## Cron schedule reference

All times UTC. pg-boss schema: `pgboss_resupply` (separate from app
tables on purpose; the `/readyz` health check probes
`pgboss_resupply.version`).

| Queue                            | Schedule                        | Side-effects                                       |
| -------------------------------- | ------------------------------- | -------------------------------------------------- |
| `reminders.scan`                 | `7 * * * *` (every hour at :07) | DB scan + fans out to `reminders.send-{sms,email}` |
| `reminders.send-sms`             | on-demand (fan-out)             | Twilio SMS                                         |
| `reminders.send-email`           | on-demand (fan-out)             | SendGrid email                                     |
| `prescriptions.attachment.sweep` | `13 3 * * 0` (Sunday 03:13)     | App Storage object delete                          |
| `idempotency-keys.prune`         | `7 2 * * *` (02:07)             | DB DELETE on `idempotency_keys` rows past 24h TTL  |
| `onboarding-checkins.dispatch`   | `17 14 * * *` (14:17)           | Twilio SMS / SendGrid email / voice press-1        |
| `onboarding-checkins.scan`       | `47 14 * * *` (14:47)           | Inserts CSR alert rows                             |
| `smart-triggers.evaluate`        | `23 3 * * *` (03:23)            | Inserts `patient_smart_trigger_events`             |
| `smart-triggers.send-due`        | `13 4 * * *` (04:13)            | SendGrid + Twilio + push                           |
| `rx-renewal.send-due`            | `43 4 * * *` (04:43)            | SendGrid + Twilio + push                           |

The 30-minute spacing between the daily cluster (03:23 → 04:13 → 04:43)
is intentional: it staggers vendor-quota burn so a transient SendGrid
or Twilio rate-limit on one queue doesn't cascade.

---

## Alert: `event: "pgboss_jobs_failed"`

### What the alert means

`startWorker()` (in `worker/index.ts`) subscribes to pg-boss's
`monitor-states` event, which fires every 60 seconds with per-queue
state counts. The handler keeps a Map of last-seen `failed` counts
per queue and emits a single structured warn line every time the
count goes UP — i.e. one log per newly-failed job, not one per tick
that the failure persists.

The log envelope:

```jsonc
{
  "event": "pgboss_jobs_failed",
  "queue": "reminders.send-sms",
  "newly_failed": 1,
  "total_failed": 3,
  "queue_size": 124, // all states combined for this queue
  "retry_pending": 0, // jobs scheduled for a future retry
  "active": 2, // jobs currently being processed
}
```

`failed` here means **terminal failure** — pg-boss has exhausted the
job's `retryLimit` (default 2 retries) and moved it to the `failed`
state. The job will not run again on its own.

### Triage in 60 seconds

1. **Identify the queue** from the log line — the cron schedule above
   tells you the workload.
2. **Check the failure mode**: was it a vendor outage (Twilio /
   SendGrid 5xx, OpenAI quota), a DB issue, or a genuine code bug?
   Filter API logs for the same `correlation_id` / `stripeEventId`
   minute window.
3. **Decide**: replay (transient failure that's now resolved),
   investigate (genuine bug), or accept (best-effort failure that
   should not have alerted — adjust the alert rule, not the code).

### Inspect a failed job

pg-boss exposes the failed-state queue in two ways. SQL is the
cheapest:

```sql
-- All jobs currently in 'failed' state for a given queue,
-- newest first. Replace the queue name as appropriate.
SELECT
  id,
  retry_count,
  state,
  startafter,
  startedon,
  completedon,
  output                  -- includes the thrown error message
FROM pgboss_resupply.job
WHERE name = 'reminders.send-sms'
  AND state = 'failed'
ORDER BY completedon DESC NULLS LAST
LIMIT 20;
```

The `output` column is JSON of the form `{"value": {"name": "Error",
"message": "...", "stack": "..."}}` — that's the thrown error from
the handler.

For an aggregate look across all queues:

```sql
SELECT name, state, count(*)
FROM pgboss_resupply.job
WHERE state IN ('failed', 'retry', 'active')
GROUP BY name, state
ORDER BY name, state;
```

### Replay a failed job

For a single job ID:

```sql
-- pg-boss sentinel: reset the job to created, clear retry counter,
-- and the next worker poll picks it up. Only do this for transient
-- failures (vendor outage, DB blip) — not for code bugs, which
-- need a fix first.
UPDATE pgboss_resupply.job
SET
  state        = 'created',
  retry_count  = 0,
  output       = NULL,
  completedon  = NULL,
  startedon    = NULL,
  startafter   = now()
WHERE id = '<uuid>'
  AND state = 'failed';
```

For an entire queue (all currently-failed jobs):

```sql
UPDATE pgboss_resupply.job
SET
  state        = 'created',
  retry_count  = 0,
  output       = NULL,
  completedon  = NULL,
  startedon    = NULL,
  startafter   = now()
WHERE name = '<queue>'
  AND state = 'failed';
```

After the UPDATE, the next worker poll (well within a minute) picks
up the rows. Confirm via the aggregate query above — `failed` count
should drop and `created` / `active` rise.

### Cancel a failed job (don't replay)

If the job should NOT be retried (e.g. the underlying patient was
deleted, the order was already manually refunded), mark it cancelled
so the failure count clears without re-running:

```sql
UPDATE pgboss_resupply.job
SET state = 'cancelled', completedon = now()
WHERE id = '<uuid>'
  AND state = 'failed';
```

### Stuck queue (jobs visible but no `active`)

If `active = 0` and `created/retry > 0` and the alert is firing,
nothing is processing the queue. Check:

1. **Is the API process up?** `/healthz` should return `200` (liveness;
   touches no dependency). If even `/healthz` is unreachable the
   process is wedged — redeploy the `resupply-api` Railway service.
   Note: `/readyz` returns `503` whenever the worker is down even
   though the process is healthy, so use `/healthz`, not `/readyz`, to
   answer "is the process up?".
2. **Is pg-boss boot complete?** The worker logs
   `"resupply in-process worker ready"` once `startWorker()` finishes.
   If that line is missing, pg-boss failed to start — but the HTTP
   server stays up regardless (boot was decoupled from the worker; see
   `artifacts/resupply-api/src/index.ts`), so the public site keeps
   serving while the worker retries on a backoff. Watch for
   `event: "worker_retry_scheduled"`; if it never reaches "worker ready", the
   likeliest cause is a DDL / schema migration mismatch in
   `pgboss_resupply.*` or the DB being unreachable. Tail logs at
   `event: "pg_boss_start_failed"` and `event: "pg_boss_error"`.
3. **Is `boss.subscribe` registered for the queue?** Each
   `register*Job(boss)` call in `startWorker()` opens a worker
   subscription. If a job was added without a corresponding
   `register*Job` registration, the queue accumulates with no
   processor.

### Drain the dead-letter (archived failures)

pg-boss archives completed and failed jobs after `archiveCompletedAfterSeconds`
(pg-boss default: 12 hours) into `pgboss_resupply.archive`. To purge
old failures permanently:

```sql
DELETE FROM pgboss_resupply.archive
WHERE state = 'failed'
  AND completedon < now() - interval '30 days';
```

Don't go below 30 days without a reason — the archive is the only
record of historic failures once the live `job` row is rotated out.

---

## Common failure modes by queue

### `reminders.scan`

- **Invalid baseline date**: handler logs a structured warn
  (`reminders.scan: missing baseline date`) and `continue`s; the
  scan does NOT fail. If the scan itself fails, it's typically a
  DB connectivity issue.
- **Atomic claim race**: covered by `FOR UPDATE SKIP LOCKED` in the
  dispatcher — duplicate sends should be impossible. If they happen,
  it indicates a regression in the claim path.

### `reminders.send-sms` / `reminders.send-email`

- **Twilio 4xx / SendGrid 4xx**: vendor rejected the message.
  _Replay only after fixing the underlying data_ (e.g. invalid phone
  number on the patient row).
- **Twilio 5xx / SendGrid 5xx**: vendor outage. Replay once vendor
  status is green.

### `prescriptions.attachment.sweep`

- **App Storage delete fail**: the underlying object was already
  removed manually. Cancel the job (don't replay) and verify the DB
  row is consistent.

### `smart-triggers.evaluate` / `smart-triggers.send-due`

- **Constraint violation on `patient_smart_trigger_events`**: usually
  the partial unique active index doing its job. Investigate; do
  not blanket-replay.

### `rx-renewal.send-due`

- **`renewal_requested_at` already set**: the dispatcher's claim
  failed because the row was claimed by another channel
  (email vs SMS). Cancel the failed job; the other channel will have
  succeeded.

### `idempotency-keys.prune`

- Should never fail — pure DELETE on a TTL column. If it does, the
  DB is in distress (wrong-permissions / out-of-disk).

### `onboarding-checkins.{dispatch,scan}`

- Same vendor-failure modes as the reminders fan-out.

---

## When to escalate

| Signal                                                              | Action                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pgboss_jobs_failed` for a single job, replayable                   | Replay; close.                                                                                   |
| Same queue alerting > 3 times / hour                                | Likely a regression. Open an incident; do not blanket-replay.                                    |
| Worker boot log missing `"in-process worker ready"` after a restart | Page the on-call. pg-boss failed to start; the API is up but no jobs run.                        |
| `pg-boss error` event in logs                                       | Check DB connectivity; pg-boss can't recover from a closed connection without a process restart. |

---

## Related code

- `artifacts/resupply-api/src/worker/index.ts` — boot, `monitor-states`
  delta-tracking, alert log envelope.
- `artifacts/resupply-api/src/worker/jobs/*.ts` — one file per cron.
- `artifacts/resupply-api/src/lib/readiness.ts` — `/readyz` probe that
  asserts the pg-boss schema is present.
- `docs/codebase-enhancements-2026-05-08.md` P1.2 — the alert source.
