// sendRefundNotificationIfNew — exactly-once "refund issued" notice.
//
// Called from the Stripe charge.refunded webhook (markStatusByPaymentIntent)
// after the order's refund is mirrored. Sends a patient notice for refunds
// that aren't already covered by the returns RMA flow — admin order refunds
// and refunds issued directly in the Stripe dashboard, which previously
// notified the customer of nothing.
//
// Coordination (no double-send):
//   * Atomic claim on shop_orders.refund_email_sent_at — the notice sends
//     at most once per order.
//   * The returns RMA refund endpoint stamps the SAME column synchronously
//     when it issues a return-driven refund (and sends its own richer,
//     return-context email), so the later charge.refunded webhook finds the
//     claim taken and skips here.
//
// On any failure after the claim we RELEASE it so a later refund event (or
// admin retry) can re-attempt. NEVER throws — the webhook has already
// mirrored the refund and must not 500 on a SendGrid/DB hiccup.
//
// PHI/log posture: counts + order id only, never the recipient.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { resolveBrandingByOrgId } from "../tenant-branding.js";
import { sendPushToCustomer } from "../web-push";
import { sendRefundNotificationEmail } from "./send-refund-notification-email.js";

export interface RefundNotificationLog {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export async function sendRefundNotificationIfNew(args: {
  orgId: string;
  orderId: string;
  amountRefundedCents: number | null;
  currency: string | null;
  isPartial: boolean;
  log: RefundNotificationLog | undefined;
}): Promise<
  { skipped: true; reason: string } | { skipped: false; delivered: boolean }
> {
  const { orgId, orderId, amountRefundedCents, currency, isPartial, log } =
    args;
  const supabase = getOrgScopedClient(orgId);

  const claimIso = new Date().toISOString();
  const { data: claimedRow, error: claimErr } = await supabase
    .from("shop_orders")
    .update({ refund_email_sent_at: claimIso, updated_at: claimIso })
    .eq("id", orderId)
    .is("refund_email_sent_at", null)
    .select("id, stripe_session_id, customer_id, customer_email")
    .limit(1)
    .maybeSingle();
  if (claimErr) {
    // Honor the "NEVER throws" contract: this runs on the Stripe
    // charge.refunded webhook path, which has already mirrored the refund
    // and must not 500 on a claim-query hiccup. Log the Error object (so
    // err.* redaction applies) and fail soft.
    log?.warn?.(
      { orderId, err: claimErr },
      "refund notification email skipped — claim query failed",
    );
    return { skipped: true, reason: "claim_failed" };
  }

  if (!claimedRow) {
    // Already notified (returns flow stamped it, or a prior refund event)
    // or the row is gone. Either way, nothing to do.
    log?.info?.(
      { orderId },
      "refund notification email skipped — already sent or row missing",
    );
    return { skipped: true, reason: "already_sent_or_missing" };
  }

  const releaseClaim = async (): Promise<void> => {
    const { error: releaseErr } = await supabase
      .from("shop_orders")
      .update({
        refund_email_sent_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimedRow.id);
    if (releaseErr) {
      log?.warn?.(
        { orderId: claimedRow.id, err: releaseErr },
        "refund notification email claim release failed",
      );
    }
  };

  try {
    // Recipient: linked shop_customers.email_lower → persisted
    // customer_email (guest checkout) → skip. Never logged.
    let toEmail: string | null = null;
    if (claimedRow.customer_id) {
      const { data: cust, error: custErr } = await supabase
        .from("shop_customers")
        .select("email_lower")
        .eq("customer_id", claimedRow.customer_id)
        .limit(1)
        .maybeSingle();
      if (custErr) throw custErr;
      if (cust?.email_lower) toEmail = cust.email_lower;
    }
    if (!toEmail && claimedRow.customer_email) {
      toEmail = claimedRow.customer_email;
    }
    if (!toEmail) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimedRow.id },
        "refund notification email skipped — no recipient on file",
      );
      return { skipped: true, reason: "no_email_on_file" };
    }

    const result = await sendRefundNotificationEmail({
      toEmail,
      stripeSessionId: claimedRow.stripe_session_id,
      amountRefundedCents,
      currency,
      isPartial,
      orgId,
    });

    if (!result.configured) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimedRow.id },
        "refund notification email skipped — sendgrid not configured",
      );
      return { skipped: true, reason: "not_configured" };
    }
    if (!result.delivered) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimedRow.id, error: result.error },
        "refund notification email send failed (non-fatal, claim released)",
      );
      return { skipped: false, delivered: false };
    }

    log?.info?.(
      { orderId: claimedRow.id, messageId: result.messageId ?? null },
      "refund notification email delivered",
    );

    // Best-effort push fan-out. Same news, separate channel.
    if (claimedRow.customer_id) {
      try {
        const brand = await resolveBrandingByOrgId(orgId);
        const counts = await sendPushToCustomer(orgId, claimedRow.customer_id, {
          title: `Refund issued — ${brand.storefrontName}`,
          body: "A refund has been issued to your original payment method.",
          // The retail Orders tab went with the cash-pay storefront, so
          // /account/orders no longer resolves. Point at the account itself.
          url: "/account",
          tag: `shop_order_refund:${claimedRow.id}`,
        });
        if (counts.delivered + counts.expired + counts.transient > 0) {
          log?.info?.(
            { orderId: claimedRow.id, ...counts },
            "refund notification push fan-out complete",
          );
        }
      } catch (err) {
        log?.warn?.(
          { orderId: claimedRow.id, err },
          "refund notification push send threw (non-fatal)",
        );
      }
    }

    return { skipped: false, delivered: true };
  } catch (err) {
    await releaseClaim();
    log?.warn?.(
      { orderId: claimedRow.id, err },
      "refund notification email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}
