// sendDeliveredNotificationIfNew — exactly-once orchestrator for the
// "your order arrived" notification (email + push + SMS + caregiver copy).
//
// Lives in lib (not the admin route) because TWO call sites fire it and
// they can race:
//   1. POST /admin/shop/orders/:id/delivered  — an admin marks delivered.
//   2. applyCarrierTrackingEvent              — a carrier webhook stamps
//                                               delivered_at automatically.
// The atomic claim on shop_orders.delivered_email_sent_at guarantees the
// notice is sent exactly once even if both land within milliseconds.
//
// Posture mirrors sendShippingNotificationIfNew:
//   * ATOMIC CLAIM then RELEASE-on-failure so a SendGrid/Twilio hiccup
//     never permanently suppresses the notice (a later re-mark retries).
//   * NEVER throws — both callers have already advanced the delivery
//     state and must not 500 / break a webhook ACK on a comms failure.
//   * Tracking is OPTIONAL (a webhook can deliver an order whose
//     carrier/number we never recorded); the email still makes sense.
//   * PHI/log posture: counts + order id only, never the recipient.

import {
  getOrgScopedClient,
  type SavedShippingAddress,
} from "@workspace/resupply-db";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { resolveTenantSmsClientOptions } from "../messaging/tenant-telecom";
import { resolveSmsRecipientForShopOrder } from "../shop-orders-sms-resolver";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import { sendPushToCustomer } from "../web-push";
import { sendDeliveredNotificationEmail } from "./send-delivered-notification-email.js";

export interface DeliveredNotificationLog {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export async function sendDeliveredNotificationIfNew(args: {
  orgId: string;
  orderId: string;
  log: DeliveredNotificationLog | undefined;
}): Promise<
  { skipped: true; reason: string } | { skipped: false; delivered: boolean }
> {
  const { orgId, orderId, log } = args;
  const supabase = getOrgScopedClient(orgId);

  const claimIso = new Date().toISOString();
  const { data: claimedRow, error: claimErr } = await supabase
    .from("shop_orders")
    .update({
      delivered_email_sent_at: claimIso,
      updated_at: claimIso,
    })
    .eq("id", orderId)
    .is("delivered_email_sent_at", null)
    .select(
      "id, stripe_session_id, customer_id, shipping_address_json, tracking_carrier, tracking_number, customer_email",
    )
    .limit(1)
    .maybeSingle();
  if (claimErr) throw claimErr;

  if (!claimedRow) {
    log?.info?.(
      { orderId },
      "delivered notification email skipped — already sent or row missing",
    );
    return { skipped: true, reason: "already_sent_or_missing" };
  }

  const releaseClaim = async (): Promise<void> => {
    const { error: releaseErr } = await supabase
      .from("shop_orders")
      .update({
        delivered_email_sent_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimedRow.id);
    if (releaseErr) {
      log?.warn?.(
        { orderId: claimedRow.id, err: releaseErr },
        "delivered notification email claim release failed",
      );
    }
  };

  try {
    // Recipient resolution: linked customer → persisted customer_email →
    // skip. We never log the recipient string. Also pull caregiver
    // columns so we can fan out a caregiver-addressed copy after the
    // primary send succeeds.
    let toEmail: string | null = null;
    let patientFirstName: string | null = null;
    let activeCaregiver: { name: string; email: string } | null = null;
    if (claimedRow.customer_id) {
      const { data: cust, error: custErr } = await supabase
        .from("shop_customers")
        .select(
          "email_lower, display_name, caregiver_name, caregiver_email, caregiver_consent_at, caregiver_revoked_at",
        )
        .eq("customer_id", claimedRow.customer_id)
        .limit(1)
        .maybeSingle();
      if (custErr) throw custErr;
      if (cust?.email_lower) toEmail = cust.email_lower;
      patientFirstName =
        (cust?.display_name ?? "").split(" ")[0]?.trim() || null;
      if (
        cust?.caregiver_email &&
        cust?.caregiver_name &&
        cust?.caregiver_consent_at &&
        !cust?.caregiver_revoked_at
      ) {
        activeCaregiver = {
          name: cust.caregiver_name,
          email: cust.caregiver_email,
        };
      }
    }
    if (!toEmail && claimedRow.customer_email) {
      toEmail = claimedRow.customer_email;
    }
    if (!toEmail) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimedRow.id },
        "delivered notification email skipped — no recipient on file",
      );
      return { skipped: true, reason: "no_email_on_file" };
    }

    const result = await sendDeliveredNotificationEmail({
      toEmail,
      stripeSessionId: claimedRow.stripe_session_id,
      carrier: claimedRow.tracking_carrier,
      trackingNumber: claimedRow.tracking_number,
      shippingAddress:
        (claimedRow.shipping_address_json as SavedShippingAddress | null) ??
        null,
      orgId,
    });

    if (!result.configured) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimedRow.id },
        "delivered notification email skipped — sendgrid not configured",
      );
      return { skipped: true, reason: "not_configured" };
    }
    if (!result.delivered) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimedRow.id, error: result.error },
        "delivered notification email send failed (non-fatal, claim released)",
      );
      return { skipped: false, delivered: false };
    }

    log?.info?.(
      { orderId: claimedRow.id, messageId: result.messageId ?? null },
      "delivered notification email delivered",
    );

    // Brand for the push title + SMS greeting fallback — never the seed
    // tenant's "PennPaps" for another tenant's customer.
    const brand = await resolveBrandingByOrgId(orgId);

    // Best-effort push fan-out. Same news, separate channel.
    if (claimedRow.customer_id) {
      try {
        const counts = await sendPushToCustomer(claimedRow.customer_id, {
          title: `Your ${brand.storefrontName} order was delivered`,
          body: "Your order has arrived.",
          url: "/account/orders",
          tag: `shop_order_delivered:${claimedRow.id}`,
        });
        if (counts.delivered + counts.expired + counts.transient > 0) {
          log?.info?.(
            { orderId: claimedRow.id, ...counts },
            "delivered notification push fan-out complete",
          );
        }
      } catch (err) {
        log?.warn?.(
          { orderId: claimedRow.id, err },
          "delivered notification push send threw (non-fatal)",
        );
      }
    }

    // SMS leg — fires when the customer matches a DME-registered patient
    // with a phone on file AND opted IN to transactional SMS.
    try {
      const smsRecipient = await resolveSmsRecipientForShopOrder({
        customerId: claimedRow.customer_id,
        customerEmailFromOrder: claimedRow.customer_email ?? null,
      });
      if (smsRecipient) {
        const smsClient = createTwilioSmsClient(
          await resolveTenantSmsClientOptions(orgId),
        );
        const greeting = smsRecipient.patientFirstName
          ? `Hi ${smsRecipient.patientFirstName}`
          : brand.storefrontName;
        await smsClient.sendSms({
          to: smsRecipient.phoneE164,
          body: `${greeting}: your CPAP supplies were delivered. Reply STOP to opt out.`,
        });
        log?.info?.(
          { orderId: claimedRow.id, channel: "sms" },
          "delivered notification sms send complete",
        );
      }
    } catch (smsErr) {
      if (!(smsErr instanceof TwilioConfigError)) {
        log?.warn?.(
          {
            orderId: claimedRow.id,
            err: smsErr instanceof Error ? smsErr.message : String(smsErr),
          },
          "delivered notification sms send threw (non-fatal)",
        );
      }
    }

    // Caregiver-addressed copy ("delivered" kind already supported).
    if (activeCaregiver) {
      try {
        const { sendCaregiverNotificationEmail } =
          await import("./send-caregiver-notification-email.js");
        await sendCaregiverNotificationEmail({
          toEmail: activeCaregiver.email,
          caregiverName: activeCaregiver.name,
          patientFirstName,
          kind: "delivered",
          orgId,
        });
      } catch (err) {
        log?.warn?.(
          { orderId: claimedRow.id, err },
          "delivered notification caregiver send threw (non-fatal)",
        );
      }
    }

    return { skipped: false, delivered: true };
  } catch (err) {
    await releaseClaim();
    log?.warn?.(
      { orderId: claimedRow.id, err },
      "delivered notification email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}
