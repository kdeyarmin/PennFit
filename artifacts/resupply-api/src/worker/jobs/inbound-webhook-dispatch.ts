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

import { dispatchParachute } from "../../lib/inbound-dispatchers/parachute";
import { logger } from "../../lib/logger";

const JOB = "integrations.inbound-webhook-dispatch";
const CRON = "* * * * *"; // every minute
const BATCH_SIZE = 50;

export interface DispatchStats {
  scanned: number;
  processed: number;
  rejected: number;
  retried: number;
  skipped_unknown_source: number;
}

export async function runInboundWebhookDispatcher(): Promise<DispatchStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: DispatchStats = {
    scanned: 0,
    processed: 0,
    rejected: 0,
    retried: 0,
    skipped_unknown_source: 0,
  };

  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .select(
      "id, source, payload_json, verification_headers_json, signature_verified",
    )
    .in("status", ["received", "processing_failed"])
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    logger.error(
      { err: error.message },
      "inbound_webhook_dispatch_select_failed",
    );
    throw error;
  }
  if (!rows || rows.length === 0) return stats;
  stats.scanned = rows.length;

  for (const row of rows) {
    if (row.source === "parachute") {
      const outcome = await dispatchParachute({ row });
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
    } else {
      // No dispatcher for this source yet. Leave the row in its
      // current status so the admin dashboard can flag it. Counting
      // only — no DB writes here.
      stats.skipped_unknown_source += 1;
    }
  }

  return stats;
}

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

export async function registerInboundWebhookDispatchJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB);
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
