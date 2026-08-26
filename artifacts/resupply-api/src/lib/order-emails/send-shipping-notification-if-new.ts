// Shipping-notification fan-out for a shop order (email → push → SMS →
// caregiver copy), with an atomic single-send claim.
//
// Lived in routes/admin/shop-orders.ts until the cash-pay storefront was
// retired. The admin order book went with it, but the XPS Ship label flow
// still stamps tracking onto existing shop_orders rows and needs to notify
// the customer, so the orchestration moved here next to the email senders
// it drives.

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
import { resolveBrandingByOrgId } from "../tenant-branding";
import { sendPushToCustomer } from "../web-push";
import { sendShippingNotificationEmail } from "./send-shipping-notification-email";

/**
 * Send the "your order shipped" email at most once per
 * (carrier, trackingNumber) combination. Called after the tracking
 * UPDATE in the POST /admin/shop/orders/:id/tracking handler.
 *
 * Idempotency model (concurrent-safe):
 *   1. The route's tracking UPDATE both stamps the new tracking AND
 *      conditionally CLEARS `shipping_email_sent_at` in the same
 *      atomic statement, ONLY if carrier or number actually changed
 *      vs the prior row values.
 *   2. This helper then performs an ATOMIC CLAIM on the (possibly
 *      cleared) timestamp:
 *        UPDATE … SET shipping_email_sent_at = now()
 *        WHERE id = $1 AND shipping_email_sent_at IS NULL RETURNING …
 *      Only one worker can win the row even if two admins click
 *      "save tracking" within milliseconds.
 *   3. On send failure we RELEASE the claim
 *      (shipping_email_sent_at = NULL) so the next admin save (or a
 *      manual retry) can re-attempt.
 *
 * Recipient resolution:
 *   * Linked `shop_customers.email_lower` (joined on `customer_id`)
 *     wins. For guest checkouts (customer_id NULL) we fall back to
 *     `shop_orders.customer_email` captured at paid-time (migration
 *     0017). If neither is present, skip silently.
 *
 * Errors NEVER throw — the admin route already 200'd the UPDATE; we
 * must not fail the response because SendGrid is misconfigured.
 */
export async function sendShippingNotificationIfNew(args: {
  orgId: string;
  orderId: string;
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined;
}): Promise<
  { skipped: true; reason: string } | { skipped: false; delivered: boolean }
> {
  const { orgId, orderId, log } = args;
  const supabase = getOrgScopedClient(orgId);

  // Atomic claim — wins iff shipping_email_sent_at is currently NULL.
  // The route's prior UPDATE has either left the timestamp non-null
  // (re-entry of identical tracking → claim fails → skip) or NULL
  // (first send OR genuine re-ship → claim succeeds → send).
  const claimIso = new Date().toISOString();
  const { data: claimedRow, error: claimErr } = await supabase
    .from("shop_orders")
    .update({
      shipping_email_sent_at: claimIso,
      updated_at: claimIso,
    })
    .eq("id", orderId)
    .is("shipping_email_sent_at", null)
    .select(
      "id, stripe_session_id, customer_id, shipping_address_json, tracking_carrier, tracking_number, customer_email",
    )
    .limit(1)
    .maybeSingle();
  if (claimErr) throw claimErr;

  if (!claimedRow) {
    log?.info?.(
      { orderId },
      "shipping notification email skipped — already sent or row missing",
    );
    return { skipped: true, reason: "already_sent_or_missing" };
  }

  // From here on, ANY failure path MUST release the claim by writing
  // shipping_email_sent_at = NULL so a future admin re-save can retry.
  // Idempotent: safe to call multiple times. The outer try/catch below
  // guarantees release on ANY thrown error in the post-claim block —
  // including transient DB errors during the customer lookup — so a
  // transient failure can never permanently lock out the email.
  const releaseClaim = async (): Promise<void> => {
    const { error: releaseErr } = await supabase
      .from("shop_orders")
      .update({
        shipping_email_sent_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimedRow.id);
    if (releaseErr) {
      log?.warn?.(
        {
          orderId: claimedRow.id,
          err: releaseErr,
        },
        "shipping notification email claim release failed",
      );
    }
  };

  try {
    if (!claimedRow.tracking_carrier || !claimedRow.tracking_number) {
      // Defence in depth — schema enforces non-empty, but the email
      // body would render nonsense without these.
      await releaseClaim();
      return { skipped: true, reason: "tracking_missing" };
    }

    // Recipient resolution: linked customer → persisted customer_email
    // (captured from Stripe at paid-time) → skip. We never log the
    // recipient string. Also pull caregiver columns so we can fan
    // out a separate caregiver-addressed copy after the primary
    // send succeeds.
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
        "shipping notification email skipped — no recipient on file",
      );
      return { skipped: true, reason: "no_email_on_file" };
    }

    const result = await sendShippingNotificationEmail({
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
        "shipping notification email skipped — sendgrid not configured",
      );
      return { skipped: true, reason: "not_configured" };
    }
    if (!result.delivered) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimedRow.id, error: result.error },
        "shipping notification email send failed (non-fatal, claim released)",
      );
      return { skipped: false, delivered: false };
    }

    log?.info?.(
      { orderId: claimedRow.id, messageId: result.messageId ?? null },
      "shipping notification email delivered",
    );

    // Best-effort push fan-out. Same news, separate channel — runs
    // after the email so a push misconfig can never block delivery
    // of the canonical notification. Logged with structural counts
    // only; the helper itself never logs the payload or endpoint URL.
    if (claimedRow.customer_id) {
      try {
        // Tenant-branded, not hardcoded: this push reaches the patient
        // verbatim and never passes the I/O-boundary rename that email
        // copy does, so a literal here showed the seed tenant's name to
        // every other tenant's patients. Same resolver and same field as
        // the email above, so the two channels can't disagree on the brand.
        const pushBrand = await resolveBrandingByOrgId(orgId);
        const counts = await sendPushToCustomer(orgId, claimedRow.customer_id, {
          title: `Your ${pushBrand.storefrontName} order shipped`,
          body: `${claimedRow.tracking_carrier} · ${claimedRow.tracking_number}`,
          // The retail Orders tab went with the cash-pay storefront, so
          // /account/orders no longer resolves to anything (its hash
          // redirect falls through to Overview). Point at the account
          // itself; the carrier and tracking number are already in the
          // body above, which is the actionable part of this push.
          url: "/account",
          tag: `shop_order_shipped:${claimedRow.id}`,
        });
        if (counts.delivered + counts.expired + counts.transient > 0) {
          log?.info?.(
            { orderId: claimedRow.id, ...counts },
            "shipping notification push fan-out complete",
          );
        }
      } catch (err) {
        // Push failures must not retro-actively change the email
        // outcome. Log and move on.
        log?.warn?.(
          {
            orderId: claimedRow.id,
            err,
          },
          "shipping notification push send threw (non-fatal)",
        );
      }
    }

    // SMS leg — fires when the customer's email matches a DME-
    // registered patients row whose phone_e164 is on file AND the
    // shop_customer comm-prefs opted IN to transactional SMS. Runs
    // after the email + push so an SMS misconfig can never roll
    // back the canonical email delivery.
    try {
      const smsRecipient = await resolveSmsRecipientForShopOrder({
        customerId: claimedRow.customer_id,
        customerEmailFromOrder: claimedRow.customer_email ?? null,
        orgId,
      });
      if (smsRecipient) {
        // Send under the tenant's own number / Messaging Service when it
        // has one (G7); falls back to the platform env default otherwise.
        const smsClient = createTwilioSmsClient(
          await resolveTenantSmsClientOptions(orgId),
        );
        // Tenant brand when the patient's first name is unknown — never the
        // seed tenant's "Penn Home Medical Supply" for another tenant's customer. Resolved
        // once (cached, fail-soft); the greeting doesn't depend on it.
        const brand = await resolveBrandingByOrgId(orgId);
        const greeting = smsRecipient.patientFirstName
          ? `Hi ${smsRecipient.patientFirstName}`
          : brand.storefrontName;
        await smsClient.sendSms({
          to: smsRecipient.phoneE164,
          body: `${greeting}: your CPAP supplies just shipped (${claimedRow.tracking_carrier} ${claimedRow.tracking_number}). Reply STOP to opt out.`,
        });
        log?.info?.(
          { orderId: claimedRow.id, channel: "sms" },
          "shipping notification sms send complete",
        );
      }
    } catch (smsErr) {
      if (!(smsErr instanceof TwilioConfigError)) {
        log?.warn?.(
          {
            orderId: claimedRow.id,
            err: smsErr instanceof Error ? smsErr.message : String(smsErr),
          },
          "shipping notification sms send threw (non-fatal)",
        );
      }
    }

    // Caregiver-addressed copy. Separate email (not BCC) with copy
    // that correctly addresses the caregiver as the caregiver. Runs
    // after the primary send + push so a caregiver-side failure
    // cannot retro-actively roll back the patient's email outcome.
    if (activeCaregiver) {
      try {
        const { sendCaregiverNotificationEmail } =
          await import("../../lib/order-emails/send-caregiver-notification-email");
        await sendCaregiverNotificationEmail({
          toEmail: activeCaregiver.email,
          caregiverName: activeCaregiver.name,
          patientFirstName,
          kind: "shipped",
          carrier: claimedRow.tracking_carrier,
          trackingNumber: claimedRow.tracking_number,
          orgId,
        });
      } catch (err) {
        log?.warn?.(
          {
            orderId: claimedRow.id,
            err,
          },
          "shipping notification caregiver send threw (non-fatal)",
        );
      }
    }

    return { skipped: false, delivered: true };
  } catch (err) {
    // Catch-all: ANY uncaught error after the claim acquisition
    // (transient DB read failure, unexpected throw inside the email
    // helper, etc.) must release the claim so the next admin re-save
    // can retry — otherwise a single transient failure would
    // permanently suppress the shipping notification.
    await releaseClaim();
    log?.warn?.(
      {
        orderId: claimedRow.id,
        err,
      },
      "shipping notification email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}
