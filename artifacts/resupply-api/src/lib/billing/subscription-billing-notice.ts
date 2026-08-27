// Subscription billing notice dispatcher.
//
// Fired from the Stripe webhook handler for storefront Subscribe & Save
// subscriptions:
//   - invoice.upcoming  → "renewing_soon" advance notice
//   - invoice.paid (subscription_cycle) → "receipt"
//
// Resolves the Stripe customer back to the STOREFRONT shop_customer that
// owns the subscription (NOT the DME `patients` table — a cash-pay shop
// subscriber may have no patient record, and the existing payment_failed
// alert already covers the patient-resolved path). Sends the transactional
// email under the tenant's own From/brand.
//
// Why a separate module from the webhook handler:
//   * The webhook must ACK Stripe in milliseconds; a SendGrid round-trip
//     cannot sit on its critical path. Callers route through the
//     retry-backed pg-boss queue (worker/jobs/subscription-billing-notice)
//     and fall back to the fire-and-forget wrapper here only when the
//     worker isn't running.
//   * Keeps the Stripe-customer → shop_customer resolution testable in
//     isolation.
//
// Idempotency: the webhook's stripe_webhook_events event-id gate dedupes
// redelivered events upstream, so this module does no claiming of its own.

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  sendSubscriptionBillingEmail,
  type SubscriptionBillingEmailKind,
} from "../order-emails/send-subscription-billing-email.js";

export interface SubscriptionBillingNoticeInput {
  /**
   * Tenant the subscription belongs to. The webhook resolves this from the
   * connected account (or seed org); when null we fall back to the seed
   * org so single-tenant deployments still resolve cleanly.
   */
  orgId: string | null;
  kind: SubscriptionBillingEmailKind;
  /** Stripe customer id from the invoice (string form). */
  stripeCustomerId: string | null;
  /** Invoice amount in the smallest currency unit (cents). */
  amountCents: number | null;
  currency: string | null;
  /** Renewal / charge date as an ISO string (optional). */
  chargeDateIso?: string | null;
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  } | null;
}

/**
 * Resolve the shop customer behind a subscription invoice and send the
 * billing notice. Never throws — every failure path logs and returns.
 * Safe to call fire-and-forget.
 */
export async function maybeSendSubscriptionBillingNotice(
  input: SubscriptionBillingNoticeInput,
): Promise<void> {
  try {
    await sendSubscriptionBillingNoticeOrThrow(input);
  } catch (err) {
    input.log?.warn?.(
      { event: "subscription_billing_notice_error", err },
      "billing: subscription notice dispatch failed (non-fatal)",
    );
  }
}

/**
 * Same resolution chain, but transient failures (Supabase error, SendGrid
 * API error) PROPAGATE so a retry-backed caller (the pg-boss job) can
 * re-attempt. Unresolvable inputs (no customer id, no shop customer,
 * SendGrid unconfigured) return cleanly — retrying those can't succeed.
 */
export async function sendSubscriptionBillingNoticeOrThrow(
  input: SubscriptionBillingNoticeInput,
): Promise<void> {
  const { stripeCustomerId, kind, log } = input;
  if (!stripeCustomerId) return;

  const orgId = input.orgId?.trim();
  if (!orgId) return;
  const supabase = getOrgScopedClient(orgId);

  // Stripe customer → shop_customers.email_lower. This is the storefront
  // subscriber; we never log the email itself.
  const { data: shopCustomer, error: scErr } = await supabase
    .from("shop_customers")
    .select("email_lower")
    .eq("stripe_customer_id", stripeCustomerId)
    .limit(1)
    .maybeSingle();
  if (scErr) throw scErr;
  const email = shopCustomer?.email_lower;
  if (!email) {
    log?.info?.(
      {
        event: "subscription_billing_notice_skipped",
        kind,
        reason: "no_shop_customer",
      },
      "billing: subscription notice — no shop_customer for stripe customer",
    );
    return;
  }

  const result = await sendSubscriptionBillingEmail({
    toEmail: email,
    kind,
    amountCents: input.amountCents,
    currency: input.currency,
    chargeDateIso: input.chargeDateIso ?? null,
    orgId,
  });

  if (!result.configured) {
    log?.info?.(
      {
        event: "subscription_billing_notice_skipped",
        kind,
        reason: "sendgrid_not_configured",
      },
      "billing: subscription notice — sendgrid not configured",
    );
    return;
  }
  if (!result.delivered) {
    // A SendGrid API error is transient — throw so the pg-boss retry/DLQ
    // budget applies.
    throw new Error(
      `subscription billing notice (${kind}) send failed: ${result.error ?? "unknown"}`,
    );
  }

  log?.info?.(
    {
      event: "subscription_billing_notice_dispatched",
      kind,
      message_id: result.messageId ?? null,
    },
    "billing: subscription notice — dispatch complete",
  );
}
