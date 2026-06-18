// pg-boss job: platform outreach email send tick.
//
// The platform-level twin of bulk-campaign-tick. One tick claims a
// batch of N pending recipients for one platform_email_campaigns row,
// sends via the platform's OWN SendGrid sender (createSendgridClient —
// SENDGRID_FROM_EMAIL / "CareMetric Breathe"), updates the rows, then
// either enqueues the next tick, marks the campaign 'sent', or exits if
// it was paused/cancelled.
//
// Differences from bulk-campaign-tick: these tables are platform-global
// (no org_id), the body is a fixed subject/html/text on the campaign row
// (not a tenant message template), and the only at-send re-check is the
// contact unsubscribe flag. The claim → send → finalize → re-enqueue
// loop and the stale-'sending' lease recovery are identical.

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  batchSizeForThrottle,
  buildOutreachBody,
  customArgsFor,
  PLATFORM_EMAIL_TICK_JOB,
  platformPublicBaseUrl,
  TICK_INTERVAL_SECONDS,
  unsubscribeUrlForContact,
} from "../../lib/platform-outreach/dispatch.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export { PLATFORM_EMAIL_TICK_JOB };

const MAX_SEND_ATTEMPTS = 3;
const PENDING_STATUSES = ["pending", "retry_pending"] as const;
const SENDING_LEASE_MS = 15 * 60_000;
const SYSTEM_ACTOR_EMAIL = "system:worker:platform-email";

export interface PlatformEmailTickPayload {
  campaignId: string;
}

export async function registerPlatformEmailTickJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    PLATFORM_EMAIL_TICK_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work<PlatformEmailTickPayload>(
    PLATFORM_EMAIL_TICK_JOB,
    async (jobs) => {
      const arr = Array.isArray(jobs) ? jobs : [jobs];
      for (const j of arr) {
        await processTick(boss, j.data, logger);
      }
    },
  );
  logger.info(
    { queue: PLATFORM_EMAIL_TICK_JOB },
    "platform email tick worker registered",
  );
}

export async function processTick(
  boss: PgBoss,
  payload: PlatformEmailTickPayload,
  log: typeof logger,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();

  // 1. Re-read campaign so a pause/cancel landed after scheduling is honored.
  const { data: campaign, error: cErr } = await supabase
    .schema("resupply")
    .from("platform_email_campaigns")
    .select(
      "id, name, subject, body_html, body_text, status, throttle_per_minute",
    )
    .eq("id", payload.campaignId)
    .limit(1)
    .maybeSingle();
  if (cErr) {
    log.error(
      { err: cErr.message },
      "platform_email.tick: campaign read failed",
    );
    throw cErr;
  }
  if (!campaign) {
    log.warn(
      { campaignId: payload.campaignId },
      "platform_email.tick: campaign missing — likely cancelled & cleaned up",
    );
    return;
  }
  if (campaign.status !== "sending") {
    log.info(
      { campaignId: campaign.id, status: campaign.status },
      "platform_email.tick: campaign no longer sending — exiting tick",
    );
    return;
  }

  // 1b. Recover orphaned recipients (a prior tick crashed mid-batch).
  const staleSendingBefore = new Date(
    Date.now() - SENDING_LEASE_MS,
  ).toISOString();
  const { data: reclaimed, error: reclaimErr } = await supabase
    .schema("resupply")
    .from("platform_email_recipients")
    .update({ status: "pending" })
    .eq("campaign_id", campaign.id)
    .eq("status", "sending")
    .lt("updated_at", staleSendingBefore)
    .select("id");
  if (reclaimErr) {
    log.warn(
      { err: reclaimErr, campaignId: campaign.id },
      "platform_email.tick: stale 'sending' reclaim failed (continuing)",
    );
  } else if ((reclaimed ?? []).length > 0) {
    log.warn(
      { campaignId: campaign.id, reclaimedCount: reclaimed!.length },
      "platform_email.tick: reclaimed stale 'sending' recipients — a prior tick crashed mid-batch",
    );
  }

  // 2. Claim a batch of pending recipients.
  const batchSize = batchSizeForThrottle(campaign.throttle_per_minute);
  const { data: pendingRows, error: pErr } = await supabase
    .schema("resupply")
    .from("platform_email_recipients")
    .select("id, recipient_kind, recipient_ref, recipient_email, send_attempts")
    .eq("campaign_id", campaign.id)
    .in("status", PENDING_STATUSES)
    .limit(batchSize);
  if (pErr) {
    log.error(
      { err: pErr.message },
      "platform_email.tick: pending fetch failed",
    );
    throw pErr;
  }
  if (!pendingRows || pendingRows.length === 0) {
    await finalizeOrReschedule(boss, campaign.id, log);
    return;
  }

  const claimedIds = pendingRows.map((r) => r.id);
  const claimed: Array<{
    id: string;
    recipient_email: string;
    recipient_kind: string;
    recipient_ref: string | null;
    send_attempts: number;
  }> = [];
  for (let i = 0; i < claimedIds.length; i += 200) {
    const idChunk = claimedIds.slice(i, i + 200);
    const { data, error: claimErr } = await supabase
      .schema("resupply")
      .from("platform_email_recipients")
      .update({ status: "sending" })
      .in("id", idChunk)
      .in("status", PENDING_STATUSES)
      .select(
        "id, recipient_email, recipient_kind, recipient_ref, send_attempts",
      );
    if (claimErr) {
      log.error({ err: claimErr.message }, "platform_email.tick: claim failed");
      throw claimErr;
    }
    if (data) claimed.push(...data);
  }
  if (claimed.length === 0) {
    log.info(
      { campaignId: campaign.id },
      "platform_email.tick: race lost on claim, deferring",
    );
    await enqueueNextTick(boss, campaign.id);
    return;
  }

  // 3. Send. Platform default sender (createSendgridClient — no tenant override).
  const { createSendgridClient } = await import("@workspace/resupply-email");
  let sendgridClient;
  try {
    sendgridClient = createSendgridClient();
  } catch (err) {
    // Email not configured — roll the claim back and bail so a later
    // tick retries once credentials exist.
    log.error(
      { err, campaignId: campaign.id },
      "platform_email.tick: SendGrid not configured — rolling back claim",
    );
    await supabase
      .schema("resupply")
      .from("platform_email_recipients")
      .update({ status: "pending" })
      .in(
        "id",
        claimed.map((r) => r.id),
      );
    return;
  }

  const baseUrl = platformPublicBaseUrl();
  let sent = 0;
  let failed = 0;
  let retried = 0;
  let suppressedAtSend = 0;

  for (const row of claimed) {
    const email = row.recipient_email;
    // At-send unsubscribe re-check for saved contacts (a campaign can run
    // for a while; honor an opt-out that landed mid-send).
    if (row.recipient_kind === "contact" && row.recipient_ref) {
      const { data: contact } = await supabase
        .schema("resupply")
        .from("platform_contacts")
        .select("unsubscribed")
        .eq("id", row.recipient_ref)
        .limit(1)
        .maybeSingle();
      if (contact?.unsubscribed) {
        await supabase
          .schema("resupply")
          .from("platform_email_recipients")
          .update({
            status: "suppressed",
            suppression_reason: "unsubscribed_at_send_time",
          })
          .eq("id", row.id);
        suppressedAtSend += 1;
        continue;
      }
    }

    const unsubscribeUrl =
      row.recipient_kind === "contact"
        ? unsubscribeUrlForContact(row.recipient_ref, baseUrl)
        : null;
    const body = buildOutreachBody({
      bodyHtml: campaign.body_html,
      bodyText: campaign.body_text,
      unsubscribeUrl,
    });

    try {
      const result = await sendgridClient.sendEmail({
        to: email,
        subject: campaign.subject,
        html: body.html,
        text: body.text,
        customArgs: customArgsFor(campaign.id, row.id),
      });
      const { error: finalizeErr } = await supabase
        .schema("resupply")
        .from("platform_email_recipients")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          vendor_message_id: result.messageId,
        })
        .eq("id", row.id);
      if (finalizeErr) {
        // Vendor accepted; park as failed (with the vendor id) to avoid a
        // duplicate re-send via the stale-lease reclaim.
        log.error(
          {
            err: finalizeErr.message,
            recipientId: row.id,
            vendorMessageId: result.messageId,
          },
          "platform_email.tick: 'sent' finalize failed after vendor accept — parking as failed",
        );
        await supabase
          .schema("resupply")
          .from("platform_email_recipients")
          .update({
            status: "failed",
            error:
              `db_finalize_failed_after_vendor_accept: ${finalizeErr.message}`.slice(
                0,
                500,
              ),
          })
          .eq("id", row.id);
        failed += 1;
        continue;
      }
      sent += 1;
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message.slice(0, 500)
          : String(err).slice(0, 500);
      const nextAttempts = (row.send_attempts ?? 0) + 1;
      const isRetryable =
        typeof (err as { retryable?: unknown })?.retryable === "boolean" &&
        (err as { retryable: boolean }).retryable;
      const willRetry = isRetryable && nextAttempts < MAX_SEND_ATTEMPTS;
      await supabase
        .schema("resupply")
        .from("platform_email_recipients")
        .update({
          status: willRetry ? "retry_pending" : "failed",
          send_attempts: nextAttempts,
          error: message,
        })
        .eq("id", row.id);
      if (willRetry) retried += 1;
      else failed += 1;
    }
  }

  // 4. Accumulate counters atomically via the sanctioned pool accessor.
  if (sent > 0 || failed > 0 || suppressedAtSend > 0) {
    const pool = getDbPool();
    const result = await pool.query(
      `UPDATE resupply.platform_email_campaigns
       SET sent_count = sent_count + $1,
           failed_count = failed_count + $2,
           suppressed_count = suppressed_count + $3
       WHERE id = $4`,
      [sent, failed, suppressedAtSend, campaign.id],
    );
    if (result.rowCount === 0) {
      log.warn(
        { campaignId: campaign.id },
        "platform_email.tick: counter update affected 0 rows",
      );
    }
  }

  log.info(
    {
      campaignId: campaign.id,
      sent,
      failed,
      retried,
      suppressedAtSend,
      batchSize,
    },
    "platform_email.tick: batch complete",
  );

  // 5. Re-check status, then finalize or reschedule.
  const { data: nextCampaign, error: statusErr } = await supabase
    .schema("resupply")
    .from("platform_email_campaigns")
    .select("status")
    .eq("id", campaign.id)
    .limit(1)
    .maybeSingle();
  if (statusErr) {
    log.error(
      { err: statusErr, campaignId: campaign.id },
      "platform_email.tick: status re-read failed — rescheduling",
    );
  } else if (!nextCampaign || nextCampaign.status !== "sending") {
    log.info(
      { campaignId: campaign.id, status: nextCampaign?.status },
      "platform_email.tick: campaign state changed during send — not enqueueing next tick",
    );
    return;
  }

  await finalizeOrReschedule(boss, campaign.id, log);
}

async function finalizeOrReschedule(
  boss: PgBoss,
  campaignId: string,
  log: typeof logger,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { count: remaining, error } = await supabase
    .schema("resupply")
    .from("platform_email_recipients")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "retry_pending", "sending"]);
  if (error) {
    log.error(
      { err: error, campaignId },
      "platform_email.tick: remaining-work count failed — rescheduling",
    );
    await enqueueNextTick(boss, campaignId);
    return;
  }
  if (!remaining || remaining === 0) {
    const finalized = await markCampaignSent(campaignId);
    if (!finalized) {
      log.error(
        { campaignId },
        "platform_email.tick: campaign finalize failed — rescheduling",
      );
      await enqueueNextTick(boss, campaignId);
      return;
    }
    log.info(
      { campaignId },
      "platform_email.tick: drained — campaign marked sent",
    );
    return;
  }
  await enqueueNextTick(boss, campaignId);
}

async function markCampaignSent(campaignId: string): Promise<boolean> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("platform_email_campaigns")
    .update({ status: "sent", completed_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("status", "sending")
    .select("id");
  if (error) {
    logger.error(
      { err: error.message, campaignId },
      "platform_email.tick: markCampaignSent update failed",
    );
    return false;
  }
  if (updated && updated.length > 0) {
    await logAudit({
      action: "platform_email_campaign.completed",
      adminEmail: SYSTEM_ACTOR_EMAIL,
      adminUserId: null,
      targetTable: "platform_email_campaigns",
      targetId: campaignId,
      metadata: {},
      ip: null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "platform_email_campaign.completed audit failed");
    });
  }
  return true;
}

export async function enqueueNextTick(
  boss: PgBoss,
  campaignId: string,
): Promise<void> {
  await boss.send(
    PLATFORM_EMAIL_TICK_JOB,
    { campaignId },
    { startAfter: TICK_INTERVAL_SECONDS },
  );
}

export async function enqueueImmediateTick(
  boss: PgBoss,
  campaignId: string,
): Promise<void> {
  await boss.send(PLATFORM_EMAIL_TICK_JOB, { campaignId });
}
