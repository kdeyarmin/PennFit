// pg-boss job: retry-backed dispatch of the `payment_failed` patient
// alert.
//
// The Stripe `invoice.payment_failed` webhook used to fire the alert
// trigger directly with `void maybeDispatchPaymentFailedAlert(...)` —
// correct for keeping SendGrid off the webhook ACK path, but a single
// transient SendGrid/Supabase failure silently lost the alert forever
// (the webhook had already 200-acked, so Stripe never redelivers).
// Routing through a VENDOR_SEND queue gives the dispatch a real retry
// budget with backoff, and exhausted retries land in the DLQ where ops
// can see them instead of vanishing.
//
// The handler calls dispatchPaymentFailedAlertOrThrow: unresolvable
// inputs (feature flag off, no shop customer, no patient match) return
// cleanly and complete the job — retrying those can never succeed —
// while transient errors propagate so pg-boss retries.

import type PgBoss from "pg-boss";

import { dispatchPaymentFailedAlertOrThrow } from "../../lib/alerts/payment-failed-trigger";
import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

export const PAYMENT_FAILED_ALERT_JOB = "alerts.payment-failed-dispatch";

export interface PaymentFailedAlertJobData {
  stripeCustomerId: string | null;
  amountDueCents: number | null;
  currency: string | null;
}

export async function registerPaymentFailedAlertJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    PAYMENT_FAILED_ALERT_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work<PaymentFailedAlertJobData>(
    PAYMENT_FAILED_ALERT_JOB,
    async (jobs) => {
      const arr = Array.isArray(jobs) ? jobs : [jobs];
      for (const j of arr) {
        await dispatchPaymentFailedAlertOrThrow({
          stripeCustomerId: j.data.stripeCustomerId,
          amountDueCents: j.data.amountDueCents,
          currency: j.data.currency,
          log: logger,
        });
      }
    },
  );
}
