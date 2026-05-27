// pg-boss job: drain pending inbound_webhooks rows and route each
// to its per-source dispatcher.
//
// Cadence
// -------
// Every 60 seconds. Parachute Health (and future partners) POSTs
// arrive at /integrations/inbound/:source which only persists the
// row — the actual parse + referral materialisation happens here so
// the public HTTP path stays under the partner's retry budget.
//
// What the job does
// -----------------
// 1. SELECT inbound_webhooks WHERE status IN ('received',
//    'processing_failed') AND received_at <= now() (uses the
//    `inbound_webhooks_pending_idx` partial index from migration
//    0138).
// 2. For each row, hand off to the per-source dispatcher
//    (lib/inbound-dispatchers/<source>.ts). Each dispatcher returns
//    a tagged outcome:
//      - ok:true                 → status='processed'  + processed_at
//      - ok:false, permanent:true → status='rejected'  + processing_error
//      - ok:false, permanent:false → status='processing_failed' +
//        processing_error (will retry on next tick — no exponential
//        backoff yet; partner traffic is < 1k/day so a tight loop is
//        fine).
//
// Sources that have no dispatcher (e.g. 'itamar_hsat' until that
// partner ships) leave the row in 'received' forever — surfaced in
// the admin integrations dashboard for human triage.
//
// PHI posture: per-row logs carry the webhook id + source slug
// only. Payload bytes never reach the logger. The per-source
// dispatcher is responsible for its own narrower PHI rules.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { dispatchEhrFhir } from "../../lib/inbound-dispatchers/ehr-fhir";
import { dispatchParachute } from "../../lib/inbound-dispatchers/parachute";
import { logger } from "../../lib/logger";
import { createQueueWithDlq, WEBHOOK_DISPATCH_QUEUE_OPTS } from "../lib/queue-options";

const JOB = "integrations.inbound-webhook-dispatch";
const CRON = "* * * * *"; // every minute
const BATCH_SIZE = 50;
// A row that's been in 'processing' for longer than this is treated
// as orphaned (worker crash, OOM, container reschedule) and flipped
// back to 'processing_failed' so the next tick re-claims it. Chosen
// at 5 minutes — well above the 60s cron cadence, well above any
// plausible single-row dispatch latency (FHIR writes round-trip
// HTTP but cap themselves at ~30s), and inside the SIGTERM drain
// window so a coordinated shutdown doesn't false-orphan in-flight
// rows.
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

export interface DispatchStats {
  scanned: number;
  processed: number;
  rejected: number;
  retried: number;
  skipped_unknown_source: number;
}

/**
 * Dispatches pending inbound webhook rows to per-source handlers and updates each row's status based on the handler outcome.
 *
 * Selects up to the configured batch size of rows from resupply.inbound_webhooks with status `received` or `processing_failed`, routes recognized sources to their dispatcher (e.g., `parachute`), and updates database status to `processed`, `rejected`, or `processing_failed` as appropriate. Rows with no implemented dispatcher are left unchanged and counted as skipped.
 *
 * @returns Aggregated dispatch statistics: `scanned` is the number of rows examined, `processed` is the count marked processed, `rejected` is the count marked rejected, `retried` is the count marked for retry, and `skipped_unknown_source` is the count of rows skipped due to an unknown source.
 */
export async function runInboundWebhookDispatcher(): Promise<DispatchStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: DispatchStats = {
    scanned: 0,
    processed: 0,
    rejected: 0,
    retried: 0,
    skipped_unknown_source: 0,
  };

  // Phase 0 — lease recovery. Any row stuck in 'processing' for
  // longer than PROCESSING_LEASE_MS is orphaned (crashed worker,
  // OOM, restart mid-row). Flip it back to 'processing_failed' so
  // the regular claim path below re-picks it up. We don't error on
  // this — losing a recovery cycle just delays revive by 60s.
  const leaseCutoff = new Date(
    Date.now() - PROCESSING_LEASE_MS,
  ).toISOString();
  const { error: leaseErr } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .update({
      status: "processing_failed",
      processing_started_at: null,
      processing_error: "lease_expired",
    })
    .eq("status", "processing")
    .lt("processing_started_at", leaseCutoff);
  if (leaseErr) {
    logger.warn(
      { err: leaseErr.message },
      "inbound_webhook_lease_recovery_failed",
    );
  }

  // Phase 1 — candidate scan. Read rows in pending status so we have
  // a bounded list of ids to attempt to claim atomically. We do NOT
  // process from this snapshot directly — see Phase 2.
  const { data: candidates, error: scanErr } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .select("id")
    .in("status", ["received", "processing_failed"])
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (scanErr) {
    logger.error(
      { err: scanErr.message },
      "inbound_webhook_dispatch_select_failed",
    );
    throw scanErr;
  }
  if (!candidates || candidates.length === 0) return stats;

  // Phase 2 — atomic claim. UPDATE the candidate ids back to status
  // 'processing' with the still-pending guard; the returned rows are
  // the ones THIS tick exclusively owns. A second tick that races
  // overlaps with us will see the same candidate ids but the UPDATE
  // will exclude rows already flipped to 'processing' — so it gets
  // a strictly disjoint winner set. Without this, a >60s dispatcher
  // run lets the next minute's tick re-process the same row,
  // materialising duplicate patient_referral or ServiceRequest rows.
  const candidateIds = candidates.map((c) => c.id);
  const { data: claimedRows, error: claimErr } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .update({
      status: "processing",
      // Stamp the claim so the Phase 0 lease-recovery sweep above
      // can identify rows whose dispatcher never reported back.
      processing_started_at: new Date().toISOString(),
    })
    .in("id", candidateIds)
    .in("status", ["received", "processing_failed"])
    .select(
      "id, source, payload_json, verification_headers_json, signature_verified",
    );
  if (claimErr) {
    logger.error(
      { err: claimErr.message },
      "inbound_webhook_dispatch_claim_failed",
    );
    throw claimErr;
  }
  const rows = claimedRows ?? [];
  if (rows.length === 0) return stats;
  stats.scanned = rows.length;

  for (const row of rows) {
    let outcome: Awaited<ReturnType<typeof dispatchParachute>> | null = null;
    try {
      if (row.source === "parachute") {
        outcome = await dispatchParachute({ row });
      } else if (row.source.startsWith("ehr_fhir_")) {
        outcome = await dispatchEhrFhir({ row });
      }
    } catch (err) {
      // Treat an uncaught dispatcher throw as a retryable failure
      // rather than leaving the row stuck in 'processing' forever
      // (the partial pending index excludes 'processing' so a stuck
      // row never re-emerges on the next tick).
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { row_id: row.id, source: row.source, err: reason },
        "inbound_webhook_dispatcher_threw",
      );
      await markRetry(supabase, row.id, reason);
      stats.retried += 1;
      continue;
    }

    if (outcome === null) {
      // No dispatcher for this source. Move the row back out of
      // 'processing' so the admin dashboard surfaces it via the
      // pending partial index — leaving it stuck in 'processing'
      // would silently hide unknown-source rows from triage.
      await markRetry(supabase, row.id, `no_dispatcher_for_source:${row.source}`);
      stats.skipped_unknown_source += 1;
      continue;
    }
    if (outcome.ok) {
      await markProcessed(supabase, row.id);
      stats.processed += 1;
    } else if (outcome.permanent) {
      await markRejected(supabase, row.id, outcome.reason);
      stats.rejected += 1;
    } else {
      await markRetry(supabase, row.id, outcome.reason);
      stats.retried += 1;
    }
  }

  return stats;
}

/**
 * Mark an inbound webhook row as processed in the resupply.inbound_webhooks table.
 *
 * Updates the row with `status = "processed"`, sets `processed_at` to the current
 * ISO timestamp, and clears `processing_error`. If the database update fails,
 * a warning is logged but the function does not throw.
 *
 * @param supabase - Supabase service-role client used to perform the update
 * @param rowId - The `id` of the inbound_webhooks row to mark as processed
 */
async function markProcessed(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  rowId: string,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      processing_error: null,
    })
    .eq("id", rowId);
  if (error) {
    logger.warn(
      { row_id: rowId, err: error.message },
      "inbound_webhook_mark_processed_failed",
    );
  }
}

/**
 * Mark an inbound webhook row as rejected and record its processing error.
 *
 * Updates the `resupply.inbound_webhooks` row with the given `rowId` to set
 * `status` to `"rejected"`, `processed_at` to the current ISO timestamp, and
 * `processing_error` to `reason` truncated to 2000 characters. If the update
 * fails, a warning is logged; the function does not throw.
 *
 * @param rowId - The `id` of the inbound webhook row to update
 * @param reason - Error message to store in `processing_error`; will be truncated to 2000 characters
 */
async function markRejected(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  rowId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .update({
      status: "rejected",
      processed_at: new Date().toISOString(),
      processing_error: reason.slice(0, 2000),
    })
    .eq("id", rowId);
  if (error) {
    logger.warn(
      { row_id: rowId, err: error.message },
      "inbound_webhook_mark_rejected_failed",
    );
  }
}

/**
 * Marks an inbound webhook row for retry by setting its status to `processing_failed`.
 *
 * Updates the row's `processing_error` with `reason` truncated to 2000 characters and does not set `processed_at`. If the database update fails, a warning is logged.
 *
 * @param rowId - The `id` of the inbound webhook row to update
 * @param reason - Human-readable explanation for the retry that will be stored (truncated to 2000 characters)
 */
async function markRetry(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  rowId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .update({
      status: "processing_failed",
      processing_error: reason.slice(0, 2000),
    })
    .eq("id", rowId);
  if (error) {
    logger.warn(
      { row_id: rowId, err: error.message },
      "inbound_webhook_mark_retry_failed",
    );
  }
}

/**
 * Registers and schedules the inbound webhook dispatch pg-boss job and its worker.
 *
 * Creates the job queue named by `JOB`, registers a worker that runs `runInboundWebhookDispatcher`
 * on each tick (logging completion or failure), and schedules the job on the cron defined by `CRON`.
 *
 * @param boss - PgBoss instance used to create the queue, register the worker, and schedule the job
 */
export async function registerInboundWebhookDispatchJob(
  boss: PgBoss,
): Promise<void> {
  // Inbound webhook dispatching mirrors outbound delivery's posture
  // (generous retries, tight expiry, DLQ on exhaustion) since the
  // failure modes are the same shape — a downstream consumer briefly
  // 5xx'ing.
  await createQueueWithDlq(boss, JOB, WEBHOOK_DISPATCH_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    try {
      const stats = await runInboundWebhookDispatcher();
      if (stats.scanned > 0) {
        logger.info(
          { event: "integrations.inbound.dispatch.completed", ...stats },
          "integrations.inbound.dispatch: tick",
        );
      }
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "integrations.inbound.dispatch: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "integrations.inbound.dispatch scheduled");
}
