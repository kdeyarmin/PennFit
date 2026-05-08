# Worker recovery runbook

The resupply API runs `pg-boss` in-process — every cron job
(`reminders.scan`, `prescription-attachment-sweep`,
`smart-trigger-evaluator`, `smart-trigger-send`, `rx-renewal-send`,
`idempotency-keys-prune`, the multi-channel onboarding check-ins) is
managed by the same Postgres-backed queue. This runbook covers the
recurring questions that come up when something goes wrong with
those jobs.

## Where the queue lives

| Object | Notes |
| --- | --- |
| Schema `pgboss_resupply` | Created by `boss.start()` on the first run. Holds every pg-boss table. |
| Table `pgboss_resupply.job` | Active queue. One row per pending or retrying job. |
| Table `pgboss_resupply.archive` | Completed and `failed` jobs after their archive interval. |
| Table `pgboss_resupply.version` | The `/readyz` probe checks this exact table to gate traffic. |

`drizzle.resupply_migrations` is unrelated; it tracks application schema migrations.

## How we surface failures

The worker emits a single structured `WARN` line every 10 minutes
when any queue carries non-zero `failed` or `retry` job counts:

```
event=pg_boss_jobs_unhealthy queues=[{queue,failed,retry}, …]
```

The `error` event also fires for connection-pool / driver-level
issues (`event=pg_boss_error`).

> Operators: alert on either of those events firing more than twice
> in a 30 min window. A single tick can be a transient retry; a
> persistent count usually means an external dependency
> (SendGrid / Twilio / SMTP / GCS) is unhealthy.

## Common questions

### "A queue shows failed jobs — what now?"

1. Find the failed rows:
   ```sql
   SELECT id, name, output, started_on, completed_on, retry_count
   FROM pgboss_resupply.archive
   WHERE state = 'failed'
     AND completed_on > now() - interval '24 hours'
   ORDER BY completed_on DESC;
   ```
2. Read `output` — pg-boss stores the thrown error JSON-serialized
   here. Match it against the categories below.
3. If the cause has been fixed and the job is genuinely safe to
   replay, see "Replaying a failed job".

### "Should I just delete the failed rows?"

Almost never. The archive is the audit trail for cron health and is
the only record an operator has of *what* failed *when*. Truncating
hides the same failure that's about to recur.

The exceptions are:
- **`failed` rows that pre-date a code change that fixed the
  underlying bug**: replay first; if the replay also fails, the bug
  isn't fixed.
- **`failed` rows from a misconfigured local environment**: clean up
  in dev, never in prod.

### "Replaying a failed job"

Most cron jobs are idempotent (the partial-unique indexes on
`patient_smart_trigger_events`, `prescription_renewal_requests`,
etc. ensure they don't double-fire) and safe to retry. Two ways:

* **Wait for the next scheduled run.** The simplest option for the
  daily-ish crons. They'll re-evaluate the same set of rows and
  the idempotency key stops a duplicate side effect.

* **Manual re-enqueue from a Node REPL on the deploy host:**
  ```ts
  import { getBoss } from "./worker/index.js";
  const boss = getBoss();
  await boss?.send("reminders.scan", {});
  ```
  Avoid this for `prescription-attachment-sweep` (weekly) — easier
  to wait for the next Sunday than to risk racing an in-flight
  scan.

### "A job is stuck in `active` state long after the worker
restarted"

`active` rows that outlive their owning worker process get reaped
by pg-boss's maintenance pass. If one is genuinely stuck:

```sql
UPDATE pgboss_resupply.job
SET state = 'failed', output = jsonb_build_object('reason','manual-reap')
WHERE id = '...' AND state = 'active';
```

…then re-enqueue per the previous section.

## Specific failure cases

### Reminders / smart-triggers / Rx renewals

Symptoms: `reminders.scan` queue shows `failed` jobs.

Likely causes (pick one based on the `output` column):
* **`SENDGRID_API_KEY` rotated.** Confirm the deploy got the new
  value; restart the API process; the next scan will succeed.
* **Twilio account suspended / over quota.** Look for `21610` /
  `21408` style codes in the error output. The reminders codepath
  is best-effort per channel — fix the Twilio account, then wait
  for the next scheduled run.
* **DB stalled write.** Run a short `SELECT 1` against
  `DATABASE_URL` from the deploy host. If it hangs, the DB is the
  blocker, not the worker.

### Prescription attachment sweep

Symptoms: `prescription-attachment-sweep` failed.

Likely causes:
* **`PRIVATE_OBJECT_DIR` unset / typo.** The job logs a categorized
  error before pg-boss sees the throw. Fix the env, redeploy.
* **GCS auth expired.** Same fix.
* **An attachment ref disappeared between the reference SET build
  and the per-object recheck.** The job is robust to this: the
  recheck is per-object and aborts the delete if the row showed up.
  No action needed.

### Idempotency keys prune

Symptoms: `idempotency-keys-prune` failed.

Almost always a transient DB blip. The next daily run cleans up the
backlog. If 3+ consecutive runs fail, page the on-call DB owner.

### Onboarding check-ins / compliance scan

Symptoms: `onboarding-checkins.*` failures.

These are the newest cron jobs and have the most edge cases. Read
the `output` column carefully — most failures so far have been
schema mismatches after a migration, not code bugs.

## Re-architecting hints

If you find yourself updating this runbook often, the right answer
is probably one of:

* Promote the in-process worker to its own artifact when the queue
  becomes throughput-class (per the comment at the top of
  `artifacts/resupply-api/src/worker/index.ts`).
* Add per-job structured failure logs at the job-handler boundary
  so the runbook stops being the canonical interpreter of pg-boss
  `output` JSON.
* Wire a real DLQ — pg-boss only models failed-and-archived; a
  separate dead-letter queue would let on-call inspect failures
  without parsing the archive table.
