// Shared pg-boss queue defaults.
//
// pg-boss v10 sets retry / expire / dead-letter behavior at QUEUE
// creation (via `boss.createQueue(name, options)`) rather than per
// `boss.work` call. Until this file was added, every job in the
// worker tree called `boss.createQueue(name)` with no options, which
// inherits the pg-boss factory defaults:
//
//   retryLimit: 2     retryBackoff: false   retryDelay: 0
//   expireInSeconds: 15 * 60   (job expiry, not retry budget)
//   deadLetter: undefined
//
// That posture has two real failure modes:
//   (1) Poison jobs (e.g. a vendor returning 500 on a malformed
//       row) silently consume a worker slot for the full 15-minute
//       expiry on every attempt — retries fire back-to-back with no
//       backoff, so the bad job rapidly burns through its retry
//       budget and then SITS in `failed` state with no alerting hook.
//   (2) The terminal `failed` state has no dead-letter queue, so
//       there's no automated way to surface "this job exhausted its
//       retries" to ops — `worker/index.ts:monitor-states` counts
//       transitions but doesn't quarantine the row for review.
//
// The presets below close both gaps:
//   - VENDOR_SEND_QUEUE_OPTS — for queues that call Twilio /
//     SendGrid / Stripe / Anthropic / OpenAI. Higher retry budget +
//     exponential backoff so a 30-second vendor blip doesn't flake
//     the whole campaign.
//   - CRON_SCAN_QUEUE_OPTS — for hourly / daily scans whose JOB IS
//     the source of work. Retrying a failed scan is rarely useful —
//     the NEXT scheduled tick re-runs from scratch — so retry budget
//     is intentionally minimal and we lean on the cron cadence.
//   - WEBHOOK_DISPATCH_QUEUE_OPTS — for outbound HTTP delivery. We
//     want generous retries (consumer endpoints commonly 5xx briefly)
//     but a tighter expiry so a wedged HTTP socket doesn't hold a
//     worker slot for the full default.
//
// All three presets enable dead-letter routing to a per-queue DLQ
// named "<queue>.dlq". In this repo's pg-boss schema, operators
// should inspect DLQs via the shared `pgboss_resupply.job` /
// `pgboss_resupply.archive` tables filtered by
// `name = '<queue>.dlq'`, e.g.
// `select count(*) from pgboss_resupply.job where name = '<queue>.dlq'`
// or
// `select count(*) from pgboss_resupply.archive where name = '<queue>.dlq'`.
//
// Per-queue overrides are still possible at the call site by
// spreading the preset and overwriting individual fields.

import type PgBoss from "pg-boss";
import type { Queue as PgBossQueue } from "pg-boss";

/** Build a Queue config that carries the queue name + sane defaults
 *  for vendor-calling work. Caller spreads this into createQueue. */
export function buildQueueConfig(
  name: string,
  preset: Omit<PgBossQueue, "name">,
  overrides?: Partial<Omit<PgBossQueue, "name">>,
): PgBossQueue {
  // `deadLetter` is intentionally placed AFTER `...overrides` so that
  // it always wins. The design contract — asserted by the unit test
  // "deadLetter is always the DLQ name even when overrides provide a
  // different value" — is that callers can tune retry/expiry knobs
  // but cannot redirect dead-letter routing. The per-queue DLQ name
  // is what ops dashboards group by; letting one queue silently
  // re-route to a foreign DLQ would break that grouping invariant.
  return { name, ...preset, ...overrides, deadLetter: `${name}.dlq` };
}

/**
 * Create a pg-boss queue together with its dead-letter queue.
 *
 * pg-boss v10 enforces a self-referential FK on `queue.dead_letter`:
 * the DLQ row must already exist in `pgboss_resupply.queue` before
 * the main queue can be inserted with that reference. `buildQueueConfig`
 * always sets `deadLetter` to `${name}.dlq`, so callers that just do
 * `boss.createQueue(name, buildQueueConfig(name, OPTS))` will crash on
 * the FIRST boot of a newly-added queue with:
 *
 *   error: insert or update on table "queue" violates foreign key
 *   constraint "queue_dead_letter_fkey"
 *
 * Existing queues survive because `ON CONFLICT DO NOTHING` short-
 * circuits the FK check on subsequent boots — which made this trap
 * invisible until two new queues landed in May 2026 and took down
 * the API on boot.
 *
 * This helper makes the correct ordering the default for every queue:
 * create the DLQ first (idempotent — pg-boss treats createQueue as
 * upsert), then create the main queue with the dead-letter reference.
 * All worker `register*` functions should use this instead of calling
 * `boss.createQueue` + `buildQueueConfig` themselves.
 */
export async function createQueueWithDlq(
  boss: PgBoss,
  name: string,
  preset: Omit<PgBossQueue, "name">,
  overrides?: Partial<Omit<PgBossQueue, "name">>,
): Promise<void> {
  await boss.createQueue(`${name}.dlq`);
  await boss.createQueue(name, buildQueueConfig(name, preset, overrides));
}

/**
 * For queues whose work makes outbound calls to a third-party vendor
 * (Twilio, SendGrid, Stripe, Anthropic, OpenAI). Vendors have brief
 * outages, regional flips, and rate-limit windows that recover within
 * a minute — those should retry transparently. A genuinely-broken
 * row (malformed phone, bad email, deleted Stripe price) burns
 * through the budget and lands in the DLQ for human review.
 */
export const VENDOR_SEND_QUEUE_OPTS: Omit<PgBossQueue, "name"> = {
  retryLimit: 5,
  retryBackoff: true,
  // First retry ~10s, doubling: 10s, 20s, 40s, 80s, 160s.
  retryDelay: 10,
  expireInMinutes: 15,
};

/**
 * For hourly / daily cron-driven scans (reminders.scan, prior-auth-
 * expiry-sweep, etc.). The scan IS the work source — retrying a
 * failed scan is rarely useful because the next scheduled tick
 * re-runs from scratch, and a retried scan competes with the cron
 * tick for the same candidate set. One retry handles a transient
 * DB blip; beyond that, fail to the DLQ so ops sees "the 09:00 scan
 * failed" instead of an invisible silent loop.
 */
export const CRON_SCAN_QUEUE_OPTS: Omit<PgBossQueue, "name"> = {
  retryLimit: 1,
  retryBackoff: false,
  retryDelay: 5,
  expireInMinutes: 5,
};

/**
 * For outbound webhook delivery. Subscribers commonly 5xx briefly
 * during their own deploys, so a higher retry budget matters; the
 * tighter expiry guards against a hanging keep-alive socket holding
 * a worker slot longer than the worker pool can absorb.
 */
export const WEBHOOK_DISPATCH_QUEUE_OPTS: Omit<PgBossQueue, "name"> = {
  retryLimit: 8,
  retryBackoff: true,
  retryDelay: 5,
  expireInMinutes: 3,
};
