// pg-boss job: bulk-campaign send tick.
//
// One tick = claim a batch of N pending recipients for one
// campaign, render the template, send via SendGrid, update the
// recipient + campaign rows, then either:
//
//   * enqueue the next tick (startAfter = 10s) if more pending
//     recipients exist AND the campaign is still 'sending'.
//   * transition the campaign to 'sent' if no pending recipients
//     remain.
//   * exit cleanly (without enqueueing the next tick) if the
//     campaign has been paused or cancelled since the tick was
//     scheduled.
//
// Each tick claims its batch with a `status='pending' →
// 'sending'` UPDATE keyed on the row's pending status, so a
// concurrent worker can't grab the same row twice (single-row
// update is atomic in Postgres). Failures on the SendGrid call
// flip the recipient to `failed`; transient errors are not
// retried within the tick (the next tick won't re-pick a failed
// row), keeping the worker simple — a CSR who wants to retry
// failures can clone the campaign with the failed recipient ids
// as a manual_list.
//
// Why per-tick jobs instead of one long-running job
// -------------------------------------------------
// pg-boss jobs that run >5 minutes risk being marked stalled and
// re-claimed by another worker. Splitting into 10-second ticks
// keeps each invocation tiny, plays nicely with pg-boss's
// expiration semantics, and lets the API's pause/cancel surface
// take effect within at most one tick.
//
// Audit
// -----
// Per-recipient sends DO NOT individually audit (would explode
// the audit log for a 10K-recipient campaign). The campaign's
// completion or cancellation is audited from the API layer; the
// per-recipient delivery state lives on bulk_campaign_recipients.

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { renderMessage } from "@workspace/resupply-templates";

import { messageTemplateLookup } from "../../lib/message-templates/lookup.js";
import {
  batchSizeForThrottle,
  customArgsFor,
  TICK_INTERVAL_SECONDS,
} from "../../lib/bulk-campaigns/dispatch-helpers.js";
import { logger } from "../../lib/logger.js";

export const BULK_CAMPAIGN_TICK_JOB = "bulk-campaigns.send-tick";

export interface BulkCampaignTickPayload {
  campaignId: string;
}

type CampaignRow =
  Database["resupply"]["Tables"]["bulk_campaigns"]["Row"];
type CampaignUpdate =
  Database["resupply"]["Tables"]["bulk_campaigns"]["Update"];

const SYSTEM_ACTOR_EMAIL = "system:worker:bulk-campaigns";

export async function registerBulkCampaignTickJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(BULK_CAMPAIGN_TICK_JOB);
  await boss.work<BulkCampaignTickPayload>(
    BULK_CAMPAIGN_TICK_JOB,
    async (jobs) => {
      // pg-boss v9 yields a tiny batch per work() invocation; we
      // process them serially because each one is per-campaign and
      // they may contend on the same rows otherwise. In practice
      // bulkSize=1 is the natural fit (one campaign, one tick at a
      // time), but the helper handles N for forward-compat.
      const arr = Array.isArray(jobs) ? jobs : [jobs];
      for (const j of arr) {
        await processTick(boss, j.data, logger);
      }
    },
  );
  logger.info({ queue: BULK_CAMPAIGN_TICK_JOB }, "bulk campaign tick worker registered");
}

/**
 * Exported for testability. Mocked dependencies (boss, supabase,
 * sendgrid) are injected via parameters in tests; production calls
 * use the singleton instances.
 */
export async function processTick(
  boss: PgBoss,
  payload: BulkCampaignTickPayload,
  log: typeof logger,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();

  // 1. Re-read the campaign state so a pause/cancel that landed
  //    after the tick was scheduled is honored.
  const { data: campaign, error: cErr } = await supabase
    .schema("resupply")
    .from("bulk_campaigns")
    .select(
      "id, name, status, throttle_per_minute, template_key, category, sent_count, failed_count, total_recipients, suppressed_count",
    )
    .eq("id", payload.campaignId)
    .limit(1)
    .maybeSingle();
  if (cErr) {
    log.error({ err: cErr.message }, "bulk_campaigns.tick: campaign read failed");
    throw cErr;
  }
  if (!campaign) {
    log.warn(
      { campaignId: payload.campaignId },
      "bulk_campaigns.tick: campaign missing — likely cancelled & cleaned up",
    );
    return;
  }
  if (campaign.status !== "sending") {
    log.info(
      { campaignId: campaign.id, status: campaign.status },
      "bulk_campaigns.tick: campaign no longer sending — exiting tick",
    );
    return;
  }

  // 2. Claim a batch of pending recipients atomically.
  const batchSize = batchSizeForThrottle(campaign.throttle_per_minute);
  const { data: pendingRows, error: pErr } = await supabase
    .schema("resupply")
    .from("bulk_campaign_recipients")
    .select("id, recipient_kind, recipient_id, recipient_email")
    .eq("campaign_id", campaign.id)
    .eq("status", "pending")
    .limit(batchSize);
  if (pErr) {
    log.error({ err: pErr.message }, "bulk_campaigns.tick: pending fetch failed");
    throw pErr;
  }

  if (!pendingRows || pendingRows.length === 0) {
    // No more pending → mark the campaign sent.
    await markCampaignSent(supabase, campaign.id);
    log.info(
      { campaignId: campaign.id },
      "bulk_campaigns.tick: drained — campaign marked sent",
    );
    return;
  }

  // Flip the claimed batch to 'sending' in one update so a
  // concurrent worker tick can't re-claim the same rows.
  const claimedIds = pendingRows.map((r) => r.id);
  const { data: claimed, error: claimErr } = await supabase
    .schema("resupply")
    .from("bulk_campaign_recipients")
    .update({ status: "sending" })
    .in("id", claimedIds)
    .eq("status", "pending")
    .select("id, recipient_email");
  if (claimErr) {
    log.error({ err: claimErr.message }, "bulk_campaigns.tick: claim update failed");
    throw claimErr;
  }
  const winningIds = new Set((claimed ?? []).map((r) => r.id));
  if (winningIds.size === 0) {
    // Lost the race to another worker — bail out, the next tick
    // will pick up the leftovers.
    log.info(
      { campaignId: campaign.id },
      "bulk_campaigns.tick: race lost on claim, deferring",
    );
    await enqueueNextTick(boss, campaign.id);
    return;
  }

  // 3. Render the template once (variables are per-recipient, but
  //    the template lookup is shared).
  let renderable;
  try {
    renderable = await renderMessage(
      {
        templateKey: campaign.template_key,
        channel: "email",
        variables: {},
      },
      // Empty fallback — if the template is missing or the DB is
      // down, we'd rather pause the campaign than ship "(no body)"
      // to thousands of patients. The empty-bodyText check below
      // catches that.
      { subject: null, bodyHtml: null, bodyText: "" },
      messageTemplateLookup,
    );
    if (!renderable.bodyText || renderable.bodyText.trim().length === 0) {
      throw new Error(
        `template "${campaign.template_key}" rendered empty body — refusing to send`,
      );
    }
  } catch (err) {
    log.error(
      {
        campaignId: campaign.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "bulk_campaigns.tick: template render failed; pausing campaign",
    );
    // Bail the campaign — every send would fail the same way.
    await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .update({ status: "paused" })
      .eq("id", campaign.id);
    // Roll the claimed batch back to pending so the resume can pick
    // them up.
    await supabase
      .schema("resupply")
      .from("bulk_campaign_recipients")
      .update({ status: "pending" })
      .in("id", Array.from(winningIds));
    return;
  }

  // 4. Send each claimed row. SendGrid send is sequential per-tick
  //    because SendGrid's API tolerates parallel calls but the
  //    Phase B priority is correctness over throughput; parallel
  //    fan-out can come later if needed.
  let sent = 0;
  let failed = 0;
  for (const row of pendingRows) {
    if (!winningIds.has(row.id)) continue;
    const email = row.recipient_email;
    if (!email) {
      // Should be impossible — resolver suppresses empty emails —
      // but defensively flip to failed if encountered.
      await supabase
        .schema("resupply")
        .from("bulk_campaign_recipients")
        .update({ status: "failed", error: "no_email_at_send_time" })
        .eq("id", row.id);
      failed += 1;
      continue;
    }
    try {
      const client = await import("@workspace/resupply-email").then((m) =>
        m.createSendgridClient(),
      );
      const result = await client.sendEmail({
        to: email,
        subject: renderable.subject ?? `(no subject for ${campaign.template_key})`,
        html: renderable.bodyHtml ?? renderable.bodyText,
        text: renderable.bodyText,
        customArgs: customArgsFor(campaign.id, row.id),
      });
      await supabase
        .schema("resupply")
        .from("bulk_campaign_recipients")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          vendor_message_id: result.messageId,
        })
        .eq("id", row.id);
      sent += 1;
    } catch (err) {
      const message =
        err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
      await supabase
        .schema("resupply")
        .from("bulk_campaign_recipients")
        .update({ status: "failed", error: message })
        .eq("id", row.id);
      failed += 1;
    }
  }

  // 5. Update counters on the campaign row using atomic increments.
  //    We use a raw UPDATE with column references to ensure concurrent
  //    ticks properly accumulate deltas instead of clobbering each other.
  if (sent > 0 || failed > 0) {
    const pool = await import("@workspace/resupply-db").then((m) => m.getDbPool());
    // Use pg's `rowCount` instead of `rows.length`. The UPDATE has no
    // RETURNING, so `rows` is always [] and the prior length check
    // was dead code — operators got no log when a concurrent cancel
    // deleted the campaign row mid-tick.
    const result = await pool.query(
      `UPDATE resupply.bulk_campaigns
       SET sent_count = sent_count + $1,
           failed_count = failed_count + $2
       WHERE id = $3`,
      [sent, failed, campaign.id],
    );
    if (result.rowCount === 0) {
      log.warn(
        { campaignId: campaign.id },
        "bulk_campaigns.tick: counter update affected 0 rows",
      );
    }
  }

  log.info(
    { campaignId: campaign.id, sent, failed, batchSize },
    "bulk_campaigns.tick: batch complete",
  );

  // 6. Check if more pending remain; if so, schedule the next tick.
  //    Re-read the campaign status one more time so an admin cancel
  //    that landed during the send doesn't get overridden by a fresh
  //    tick enqueue.
  const { data: nextCampaign } = await supabase
    .schema("resupply")
    .from("bulk_campaigns")
    .select("status")
    .eq("id", campaign.id)
    .limit(1)
    .maybeSingle();
  if (!nextCampaign || nextCampaign.status !== "sending") {
    log.info(
      { campaignId: campaign.id, status: nextCampaign?.status },
      "bulk_campaigns.tick: campaign state changed during send — not enqueueing next tick",
    );
    return;
  }

  const { count: stillPending } = await supabase
    .schema("resupply")
    .from("bulk_campaign_recipients")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .eq("status", "pending");

  if (!stillPending || stillPending === 0) {
    await markCampaignSent(supabase, campaign.id);
    log.info(
      { campaignId: campaign.id },
      "bulk_campaigns.tick: drained — campaign marked sent",
    );
    return;
  }

  await enqueueNextTick(boss, campaign.id);
}

async function markCampaignSent(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  campaignId: string,
): Promise<void> {
  const update: CampaignUpdate = {
    status: "sent",
    completed_at: new Date().toISOString(),
  };
  const { data: updated } = await supabase
    .schema("resupply")
    .from("bulk_campaigns")
    .update(update)
    .eq("id", campaignId)
    .eq("status", "sending")
    .select("id");
  // Only audit if the update actually happened (i.e., campaign was
  // still in 'sending' state). If it was paused/cancelled during
  // the final tick, skip the completion audit.
  if (updated && updated.length > 0) {
    await logAudit({
      action: "bulk_campaign.completed",
      adminEmail: SYSTEM_ACTOR_EMAIL,
      adminUserId: null,
      targetTable: "bulk_campaigns",
      targetId: campaignId,
      metadata: {},
      ip: null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "bulk_campaign.completed audit failed");
    });
  }
}

export async function enqueueNextTick(
  boss: PgBoss,
  campaignId: string,
): Promise<void> {
  await boss.send(
    BULK_CAMPAIGN_TICK_JOB,
    { campaignId },
    { startAfter: TICK_INTERVAL_SECONDS },
  );
}

// Useful for the API's start handler to mint the very first tick
// without waiting the full TICK_INTERVAL_SECONDS.
export async function enqueueImmediateTick(
  boss: PgBoss,
  campaignId: string,
): Promise<void> {
  await boss.send(BULK_CAMPAIGN_TICK_JOB, { campaignId });
}

// Silence unused-import lint when CampaignRow isn't referenced
// directly. Kept as a documented contract for what the tick reads.
export type _CampaignRow = CampaignRow;
