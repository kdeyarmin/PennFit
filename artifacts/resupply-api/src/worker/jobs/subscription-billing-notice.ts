// pg-boss job: retry-backed dispatch of storefront subscription billing
// notices (renewing-soon advance notice + auto-renewal receipt).
//
// The Stripe invoice.upcoming / invoice.paid webhooks enqueue onto this
// queue so the SendGrid round-trip stays off the webhook ACK path, and a
// transient SendGrid/Supabase failure gets a real retry budget with
// backoff + DLQ instead of vanishing after the webhook has 200-acked.
//
// The handler calls sendSubscriptionBillingNoticeOrThrow: unresolvable
// inputs (no customer id, no shop customer, SendGrid unconfigured) return
// cleanly and complete the job — retrying those can never succeed — while
// transient errors propagate so pg-boss retries.

import type PgBoss from "pg-boss";

import {
  sendSubscriptionBillingNoticeOrThrow,
  type SubscriptionBillingNoticeInput,
} from "../../lib/billing/subscription-billing-notice";
import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

export const SUBSCRIPTION_BILLING_NOTICE_JOB =
  "billing.subscription-notice-dispatch";

export type SubscriptionBillingNoticeJobData = Omit<
  SubscriptionBillingNoticeInput,
  "log"
>;

export async function registerSubscriptionBillingNoticeJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    SUBSCRIPTION_BILLING_NOTICE_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work<SubscriptionBillingNoticeJobData>(
    SUBSCRIPTION_BILLING_NOTICE_JOB,
    async (jobs) => {
      const arr = Array.isArray(jobs) ? jobs : [jobs];
      for (const j of arr) {
        await sendSubscriptionBillingNoticeOrThrow({
          orgId: j.data.orgId,
          kind: j.data.kind,
          stripeCustomerId: j.data.stripeCustomerId,
          amountCents: j.data.amountCents,
          currency: j.data.currency,
          chargeDateIso: j.data.chargeDateIso,
          log: logger,
        });
      }
    },
  );
}
