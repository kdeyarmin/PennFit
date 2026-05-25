// pg-boss job: daily post-delivery follow-up dispatcher.
//
// Why this exists
// ---------------
// The shipping notification fires when admin enters tracking. Nothing
// fires AFTER the parcel arrives. This worker closes the loop: it
// scans paid orders that delivered 3-14 days ago without a follow-up
// stamp, and sends a "how did it go?" email. The post-delivery
// touchpoint is the single highest-ROI satisfaction surface a DME
// supplier has (>50% open rate vs. <25% for resupply nudges) and
// also creates a clean intake for early returns / breakage reports
// before the patient gives up.
//
// What this job does
// ------------------
// Daily 14:23 UTC (an off-peak slot that doesn't compete with the
// other crons: idempotency-prune 02:07, audit-archive 03:27, smart-
// trigger 03:23, prior-auth-expiry 03:47, smart-trigger-send 04:13,
// rx-renewal-send 04:43, therapy-nightly-sync 04:30, milestones
// 04:53). Mid-afternoon hits inboxes in working hours for the bulk
// of US patients.
//
//   1. SELECT orders WHERE delivered_at BETWEEN now() - 14d
//      AND now() - 3d AND delivery_followup_sent_at IS NULL
//      AND status = 'paid'.
//
//   2. For each row: atomic claim the stamp, resolve recipient
//      (shop_customers.email_lower → shop_orders.customer_email),
//      send email, web-push fan-out. Release the claim on send
//      failure so the next run retries.
//
// The 3-14 day window
// -------------------
// 3 days lower bound: gives the patient time to actually try the
// gear before we ask "is it working?". Earlier feels intrusive.
//
// 14 days upper bound: past two weeks the moment has passed; a
// "how did it go?" feels stale. The window also keeps the working
// set tiny — at any time only ~14 days of orders are eligible.
//
// Failure handling
// ----------------
// "Not configured" (no SendGrid) logs and exits clean. A SendGrid
// 5xx releases the claim and the next cron run retries. Any
// throw during recipient lookup releases the claim then re-throws
// so pg-boss marks the job failed for ops visibility.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { sendDeliveryFollowupEmail } from "../../lib/order-emails/send-delivery-followup-email";
import { sendCaregiverNotificationEmail } from "../../lib/order-emails/send-caregiver-notification-email";
import { sendPushToCustomer } from "../../lib/web-push";
import { resolveSmsRecipientForShopOrder } from "../../lib/shop-orders-sms-resolver";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";
import { logger } from "../../lib/logger";
import { buildQueueConfig, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";

const FOLLOWUP_JOB = "shop-order.delivery-followup";
const FOLLOWUP_CRON = "23 14 * * *";

/** Lower bound: 3 days before now. Earlier is intrusive. */
const MIN_DAYS_SINCE_DELIVERY = 3;
/** Upper bound: past two weeks the moment has passed. */
const MAX_DAYS_SINCE_DELIVERY = 14;

export interface FollowupSweepStats {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface ClaimableOrder {
  id: string;
  stripe_session_id: string;
  customer_id: string | null;
  customer_email: string | null;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

interface ResolvedRecipient {
  email: string;
  firstName: string | null;
  /** Active caregiver, when one is on file and not revoked. */
  caregiver: { name: string; email: string } | null;
}

async function resolveRecipient(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  order: ClaimableOrder,
): Promise<ResolvedRecipient | null> {
  if (order.customer_id) {
    const { data: cust, error } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select(
        "email_lower, display_name, caregiver_name, caregiver_email, caregiver_consent_at, caregiver_revoked_at",
      )
      .eq("customer_id", order.customer_id)
      .limit(1)
      .maybeSingle();
    if (error) {
      throw error;
    }
    if (cust?.email_lower) {
      const firstName = (cust.display_name ?? "").split(" ")[0]?.trim() || null;
      const caregiverActive =
        cust.caregiver_email &&
        cust.caregiver_name &&
        cust.caregiver_consent_at &&
        !cust.caregiver_revoked_at;
      return {
        email: cust.email_lower,
        firstName,
        caregiver: caregiverActive
          ? { name: cust.caregiver_name!, email: cust.caregiver_email! }
          : null,
      };
    }
  }
  if (order.customer_email) {
    return {
      email: order.customer_email,
      firstName: null,
      caregiver: null,
    };
  }
  return null;
}

/**
 * Exported for testability. Pure DB + send work, no clock dependency
 * other than `now` parameter for the window.
 */
export async function runDeliveryFollowupSweep(): Promise<FollowupSweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: FollowupSweepStats = {
    considered: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  const upper = isoDaysAgo(MIN_DAYS_SINCE_DELIVERY);
  const lower = isoDaysAgo(MAX_DAYS_SINCE_DELIVERY);

  const { data: candidates, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select(
      "id, stripe_session_id, customer_id, customer_email, delivered_at",
    )
    .eq("status", "paid")
    .is("delivery_followup_sent_at", null)
    .gte("delivered_at", lower)
    .lte("delivered_at", upper)
    .order("delivered_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);
  if (error) throw error;

  stats.considered = (candidates ?? []).length;

  for (const candidate of candidates ?? []) {
    // 1. Atomic claim — wins iff still null. Concurrent runs lose.
    const claimIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({
        delivery_followup_sent_at: claimIso,
        updated_at: claimIso,
      })
      .eq("id", candidate.id)
      .is("delivery_followup_sent_at", null)
      .select(
        "id, stripe_session_id, customer_id, customer_email",
      )
      .limit(1)
      .maybeSingle();
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, orderId: candidate.id },
        "shop-order.delivery-followup: claim failed",
      );
      stats.failed += 1;
      continue;
    }
    if (!claimed) {
      // Lost the race — another worker claimed it. Skip.
      stats.skipped += 1;
      continue;
    }

    const releaseClaim = async (): Promise<void> => {
      await supabase
        .schema("resupply")
        .from("shop_orders")
        .update({
          delivery_followup_sent_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimed.id);
    };

    let recipient: ResolvedRecipient | null;
    try {
      recipient = await resolveRecipient(supabase, claimed);
    } catch (err) {
      await releaseClaim();
      stats.failed += 1;
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          orderId: claimed.id,
        },
        "shop-order.delivery-followup: recipient lookup failed",
      );
      continue;
    }
    if (!recipient) {
      // No deliverable address — leave the stamp set so we don't
      // re-scan on every cron run. The skip count surfaces this.
      stats.skipped += 1;
      continue;
    }

    // 2. Send the email. Every failure path above continues; reaching
    //    the push block below means delivery succeeded.
    try {
      const result = await sendDeliveryFollowupEmail({
        toEmail: recipient.email,
        stripeSessionId: claimed.stripe_session_id,
        firstName: recipient.firstName,
        orderId: claimed.id,
      });
      if (!result.configured) {
        await releaseClaim();
        stats.skipped += 1;
        continue;
      }
      if (!result.delivered) {
        await releaseClaim();
        stats.failed += 1;
        logger.warn(
          { orderId: claimed.id, error: result.error },
          "shop-order.delivery-followup: send failed (claim released)",
        );
        continue;
      }
      stats.sent += 1;
    } catch (err) {
      await releaseClaim();
      stats.failed += 1;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          orderId: claimed.id,
        },
        "shop-order.delivery-followup: send threw (claim released)",
      );
      continue;
    }

    // 3. Best-effort push fan-out. Same news, separate channel.
    //    Push misconfig must not block the email delivery state.
    if (claimed.customer_id) {
      try {
        await sendPushToCustomer(claimed.customer_id, {
          title: "How is your CPAP setup?",
          body: "Tap to share feedback or start a return if anything is off.",
          url: "/account",
          tag: `shop_order_delivery_followup:${claimed.id}`,
        });
      } catch (pushErr) {
        logger.warn(
          {
            orderId: claimed.id,
            err: pushErr instanceof Error ? pushErr.message : String(pushErr),
          },
          "shop-order.delivery-followup: push fanout failed (non-fatal)",
        );
      }
    }

    // 4. SMS leg — same gates as the shipped event. Fires when the
    //    customer's email matches a DME-registered patient with
    //    phone_e164 + transactional SMS opt-in.
    try {
      const smsRecipient = await resolveSmsRecipientForShopOrder({
        customerId: claimed.customer_id,
        customerEmailFromOrder: claimed.customer_email ?? null,
      });
      if (smsRecipient) {
        const smsClient = createTwilioSmsClient();
        const greeting = smsRecipient.patientFirstName
          ? `Hi ${smsRecipient.patientFirstName}`
          : "PennPaps";
        await smsClient.sendSms({
          to: smsRecipient.phoneE164,
          body: `${greeting}: how is your new CPAP setup going? Reply YES if it works, or NO and we'll start a return. Reply STOP to opt out.`,
        });
      }
    } catch (smsErr) {
      if (!(smsErr instanceof TwilioConfigError)) {
        logger.warn(
          {
            orderId: claimed.id,
            err: smsErr instanceof Error ? smsErr.message : String(smsErr),
          },
          "shop-order.delivery-followup: sms send failed (non-fatal)",
        );
      }
    }

    // 5. Caregiver-addressed copy (separate email; not a BCC). Fires
    //    only when the patient has an active designated contact on
    //    file. Failures here do NOT roll back the patient's delivery
    //    stamp — the primary delivery is the canonical record.
    if (recipient.caregiver) {
      try {
        await sendCaregiverNotificationEmail({
          toEmail: recipient.caregiver.email,
          caregiverName: recipient.caregiver.name,
          patientFirstName: recipient.firstName,
          kind: "delivered",
        });
      } catch (cgErr) {
        logger.warn(
          {
            orderId: claimed.id,
            err: cgErr instanceof Error ? cgErr.message : String(cgErr),
          },
          "shop-order.delivery-followup: caregiver send failed (non-fatal)",
        );
      }
    }
  }

  return stats;
}

export async function registerShopOrderDeliveryFollowupJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(FOLLOWUP_JOB, buildQueueConfig(FOLLOWUP_JOB, VENDOR_SEND_QUEUE_OPTS));

  await boss.work(FOLLOWUP_JOB, async () => {
    try {
      const stats = await runDeliveryFollowupSweep();
      logger.info(
        { event: "shop-order.delivery-followup.completed", ...stats },
        "shop-order.delivery-followup: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "shop-order.delivery-followup: failed",
      );
      throw err;
    }
  });

  await boss.schedule(FOLLOWUP_JOB, FOLLOWUP_CRON);
  logger.info({ cron: FOLLOWUP_CRON }, "shop-order.delivery-followup scheduled");
}
