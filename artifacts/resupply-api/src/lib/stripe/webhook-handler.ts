// Stripe webhook handler — verifies signature, dispatches events to
// the local shop_orders mirror.
//
// The per-event-family side effects live in ./webhook-handlers/
// (checkout-session, subscription, payment-intent, payment-method,
// shared). This file keeps the dispatch skeleton (config gating,
// signature verification, the event-id idempotency gate, the switch)
// plus the families whose bodies are structurally pinned by
// new-events.test.ts source checks (invoice.payment_failed,
// charge.dispute.*, charge.refunded's refund mirror, and the
// order-confirmation email claim).
//
// Mounting contract (see app.ts):
//   * Route is /resupply-api/stripe/webhook.
//   * Body parser MUST be express.raw({type: "application/json"}) and
//     MUST be registered BEFORE express.json() — Stripe signature
//     verification is computed over the exact bytes Stripe sent, and
//     express.json mutates `req.body` to a parsed object that we
//     can't re-serialize byte-identically.
//   * Stripe's signing secret rotates independently of the API key,
//     so we re-read `STRIPE_WEBHOOK_SIGNING_SECRET` per-request via
//     readStripeConfigOrNull() rather than capturing it at boot.
//
// Error contract (Stripe-side):
//   * 200 = "got it, do not retry". We return 200 even for events we
//     don't care about (default branch) so Stripe stops re-delivering.
//   * 400 = "your signature/body is malformed". Stripe will retry
//     with exponential backoff, which is the right behaviour for a
//     genuine config error (we want noisy retries until we fix the
//     secret).
//   * 503 = "we know who you are but the shop isn't configured".
//     Returned only when Stripe sent a real signed payload but the
//     server itself is mid-outage. Stripe retries — exactly what we
//     want.
//
// We intentionally do NOT log the raw event body — Stripe events can
// contain customer email + shipping address, both of which are
// sensitive. We log event id + type + amount only.

import type { Request, RequestHandler, Response } from "express";
import type Stripe from "stripe";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import type { SavedShippingAddress } from "@workspace/resupply-db";

type ShopOrderUpdate = Database["resupply"]["Tables"]["shop_orders"]["Update"];

import { maybeDispatchPaymentFailedAlert } from "../alerts/payment-failed-trigger";
import { getBoss } from "../../worker/index.js";
import { PAYMENT_FAILED_ALERT_JOB } from "../../worker/jobs/payment-failed-alert.js";
import { getStripeClient, readStripeConfigOrNull } from "./config";
import { stripeErrLogFields } from "./err-log-fields";
import {
  sendOrderConfirmationEmail,
  type OrderConfirmationLineItem,
} from "../order-emails/send-order-confirmation-email";
import { tryAutoEnrollReminderFromOrder } from "../storefront/order-reminder-enrollment";
import {
  authorizePaymentPlanAutopay,
  markCartRecovered,
  markPaid,
  markStatus,
  syncCustomerAfterCheckout,
  upsertOrderItemsFromSession,
} from "./webhook-handlers/checkout-session";
import { handlePaymentIntentEvent } from "./webhook-handlers/payment-intent";
import { handlePaymentMethodDetached } from "./webhook-handlers/payment-method";
import { handleSubscriptionEvent } from "./webhook-handlers/subscription";

// Re-exports so existing importers (app.ts, the per-helper test
// suites) keep working unchanged after the module split.
export { extractShippingAddressFromSession } from "./webhook-handlers/shared";
export {
  markCartRecovered,
  syncCustomerAfterCheckout,
} from "./webhook-handlers/checkout-session";

/**
 * Try to record this event in stripe_webhook_events. Resolves to one
 * of three outcomes:
 *
 *   - "inserted"  → first time we've seen this event_id. Caller
 *                   proceeds to dispatch.
 *   - "duplicate" → INSERT failed with UNIQUE-violation (PostgREST
 *                   `23505`). Caller short-circuits with 200 +
 *                   {ok: true, deduped: true} so Stripe stops
 *                   retrying.
 *   - "error"     → INSERT failed for some other reason (DB
 *                   unreachable, etc.). Caller proceeds anyway —
 *                   downstream per-table UNIQUE guards still catch
 *                   the most-load-bearing double-writes, and we'd
 *                   rather risk a duplicate side-effect than
 *                   permanently drop a real event because the
 *                   idempotency table is offline.
 *
 * This helper NEVER throws — every code path returns a string so the
 * caller branches without try/catch.
 */
export async function tryRecordWebhookEvent(
  eventId: string,
  eventType: string,
  log: { warn?: (...args: unknown[]) => void } | undefined,
): Promise<"inserted" | "duplicate" | "error"> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("stripe_webhook_events")
      .insert({
        event_id: eventId,
        event_type: eventType,
      });
    if (!error) return "inserted";
    if ((error as { code?: string }).code === "23505") {
      return "duplicate";
    }
    log?.warn?.(
      { code: (error as { code?: string }).code },
      "stripe webhook: dedup INSERT failed (non-fatal, proceeding)",
    );
    return "error";
  } catch (err) {
    log?.warn?.(
      { err },
      "stripe webhook: dedup INSERT threw (non-fatal, proceeding)",
    );
    return "error";
  }
}

export async function tryDeleteWebhookEventRecord(
  eventId: string,
  log: { warn?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("stripe_webhook_events")
      .delete()
      .eq("event_id", eventId);
    if (!error) return;
    log?.warn?.(
      { code: (error as { code?: string }).code, eventId },
      "stripe webhook: failed to release dedup record after handler error",
    );
  } catch {
    log?.warn?.({ eventId }, "stripe webhook: dedup record cleanup threw");
  }
}

export const stripeWebhookHandler: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  const config = readStripeConfigOrNull();
  if (!config || !config.webhookSigningSecret) {
    req.log?.warn(
      { hasConfig: !!config },
      "stripe webhook hit while shop is not fully configured",
    );
    // In production, a missing webhook signing secret means the
    // operator has misconfigured the deploy — return 503 so Stripe
    // alerts surface it loudly. Outside production (preview / dev /
    // local), Stripe shouldn't be pointed here at all, but if it is
    // we ack 200 so it doesn't enter the 3-day exponential retry
    // pattern and exhaust the per-endpoint retry budget on dev
    // environments. The body marks the no-op so a developer reading
    // the dev log can tell what happened.
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "shop_unavailable" });
    } else {
      res.status(200).json({ ok: true, ignored: "shop_not_configured" });
    }
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "missing_stripe_signature" });
    return;
  }

  // express.raw gives us a Buffer here. constructEvent accepts both
  // Buffer and string; Buffer is preferred so we don't risk a
  // double-encode on platforms where the raw bytes aren't pure UTF-8
  // (Stripe payloads always are, but defence in depth is cheap).
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    req.log?.error(
      { bodyType: typeof rawBody },
      "stripe webhook: raw body was not a Buffer — body parser order is wrong",
    );
    res.status(400).json({ error: "raw_body_missing" });
    return;
  }

  const stripe = getStripeClient(config);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.webhookSigningSecret,
    );
  } catch (err) {
    // Returning 400 (not 401) is what Stripe's docs ask for — it's
    // their convention for "I refuse this delivery, try again".
    req.log?.warn(
      { ...stripeErrLogFields(err) },
      "stripe webhook signature verification failed",
    );
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  const log = req.log?.child?.({ stripeEventId: event.id, type: event.type });

  // Event-level idempotency gate. Stripe redelivers any event we
  // don't 2xx within their policy window, and that redelivery
  // carries the SAME event.id. Without this gate, the downstream
  // switch would re-run side effects (audit rows, refund mirroring,
  // subscription rotation) for events whose UNIQUE-on-table guards
  // protect SOME writes but not all. Insert the event_id first; on
  // duplicate, ack 200 + skip the switch entirely. Subsequent
  // changes downstream don't have to carry the Stripe-redelivery
  // story — this layer owns it.
  const dedupeOutcome = await tryRecordWebhookEvent(event.id, event.type, log);
  const dedupeInserted = dedupeOutcome === "inserted";
  if (dedupeOutcome === "duplicate") {
    log?.info?.("stripe webhook: event_id already recorded — deduped");
    res.status(200).json({ ok: true, deduped: true });
    return;
  }
  if (dedupeOutcome === "error") {
    // The dedup INSERT itself failed for a reason other than UNIQUE
    // conflict (Supabase unreachable, transient brownout, etc.).
    // Surface as 500 so Stripe retries with its standard exponential
    // backoff — better than running the side effects (refund mirror,
    // subscription upsert, customer-sync) un-gated and risking a
    // double-write that the per-table UNIQUE constraints don't all
    // cover. Stripe's retries handle transient backend faults; the
    // earlier "proceed without dedup" path was a foot-gun for
    // brownouts where it would re-run side effects on every redelivery.
    log?.warn?.(
      "stripe webhook: dedup insert errored — returning 500 so Stripe retries",
    );
    res.status(500).json({ error: "dedup_unavailable" });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        // Payment-plan autopay authorization (mode=setup). Capture the
        // mandated payment method and flip the plan to 'authorized'.
        // This is a distinct flow from a paid order — handle and return.
        if (
          session.mode === "setup" &&
          session.metadata?.purpose === "payment_plan_autopay"
        ) {
          // Let any failure propagate to the outer catch, which deletes
          // the dedupe record and returns 500 so Stripe RETRIES. Stripe
          // won't re-fire this event on its own, and swallowing here
          // would strand the plan in 'pending' after the patient already
          // completed the setup — so this must be retryable, not
          // best-effort.
          await authorizePaymentPlanAutopay(config, session, log);
          break;
        }
        // Patient-controlled autopay: a signed-in patient saved a card on
        // file from /account/billing. Record the card + (if they asked)
        // flip their autopay switch. Same retry-on-throw posture as the
        // plan flow — stranding a completed setup is worse than a retry.
        if (
          session.mode === "setup" &&
          session.metadata?.purpose === "patient_autopay_setup"
        ) {
          const { recordAutopayAuthorization } =
            await import("../billing/patient-autopay.js");
          await recordAutopayAuthorization(config, session, log);
          break;
        }
        const paidRow = await markPaid(session, log);
        // Best-effort: mirror the session's line items into
        // shop_order_items so the verified-purchaser badge and the
        // /shop/me/orders history page can render without a per-row
        // Stripe round-trip. Idempotent via the
        // (stripe_session_id, product_id, price_id) UNIQUE — a Stripe
        // re-delivery (or the async_payment_succeeded shadow on the
        // same session) inserts zero new rows. Failures MUST NOT
        // throw out of the webhook — the parent order is already
        // paid; the badge degrades gracefully if the items are
        // missing (one re-delivery later it'll fill in).
        let emailItems: OrderConfirmationLineItem[] = [];
        if (paidRow) {
          try {
            emailItems = await upsertOrderItemsFromSession(
              config,
              session,
              paidRow,
              log,
            );
          } catch (itemsErr) {
            log?.warn?.(
              {
                err:
                  itemsErr instanceof Error
                    ? itemsErr.message
                    : String(itemsErr),
              },
              "stripe webhook: shop_order_items upsert failed (non-fatal)",
            );
          }
        }
        // Best-effort sync of saved customer info. Failures here MUST
        // NOT throw out of the webhook — the order is paid; failing
        // to refresh "saved card last4" is recoverable on the next
        // /shop/me hit (which will re-pull from Stripe).
        try {
          await syncCustomerAfterCheckout(config, session, log);
        } catch (syncErr) {
          log?.warn?.(
            {
              err: syncErr instanceof Error ? syncErr.message : String(syncErr),
            },
            "stripe webhook: customer sync failed (non-fatal)",
          );
        }
        // Best-effort: mark the matching abandoned-cart row as
        // recovered so the dispatcher never nudges someone who
        // already converted. Failures here MUST NOT throw out of
        // the webhook — the order is paid and that's what matters.
        try {
          await markCartRecovered(session, log);
        } catch (recErr) {
          log?.warn?.(
            { err: recErr instanceof Error ? recErr.message : String(recErr) },
            "stripe webhook: cart recovery mark failed (non-fatal)",
          );
        }
        // Best-effort: send the order confirmation email. Idempotent
        // via shop_orders.confirmation_email_sent_at — a Stripe re-
        // delivery (or the async_payment_succeeded shadow on the same
        // session) sees the timestamp set and short-circuits.
        // Failures here MUST NOT throw out of the webhook —
        // SendGrid being temporarily down (or unconfigured) must not
        // cause Stripe to retry the entire webhook, which would
        // re-fire markPaid and the customer-sync side-effects.
        if (paidRow) {
          try {
            await sendOrderConfirmationIfFirst({
              session,
              paidOrderId: paidRow.id,
              items: emailItems,
              log,
            });
          } catch (emailErr) {
            log?.warn?.(
              {
                err:
                  emailErr instanceof Error
                    ? emailErr.message
                    : String(emailErr),
              },
              "stripe webhook: order confirmation email failed (non-fatal)",
            );
          }
        }
        // Best-effort: enroll the buyer in replacement reminders for the
        // consumables they purchased (#4 storefront↔resupply bridge).
        // Feature-flagged + opt-out-respecting; never throws.
        if (paidRow) {
          const buyerEmail =
            session.customer_details?.email ?? session.customer_email ?? null;
          if (buyerEmail) {
            // Wrapped for parity with the other best-effort side effects in
            // this branch (markPaid / sync / cart / email). A throw here
            // would 500 the webhook, roll back the event dedup row, and
            // make Stripe re-fire ALL side effects on retry. The callee is
            // internally guarded today, but the call site must not depend
            // on that (its own header says "the caller wraps this").
            try {
              await tryAutoEnrollReminderFromOrder({
                email: buyerEmail,
                lineItems: emailItems,
                log,
              });
            } catch (enrollErr) {
              log.warn(
                {
                  err:
                    enrollErr instanceof Error
                      ? enrollErr.message
                      : String(enrollErr),
                },
                "stripe webhook: reminder auto-enroll failed (non-fatal)",
              );
            }
          }
        }
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markStatus(session.id, "expired", log);
        break;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markStatus(session.id, "failed", log);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // Subscribe & Save mirror — see webhook-handlers/subscription.ts
        // for the upsert + last_stripe_event_at ordering guard.
        await handleSubscriptionEvent(event, log);
        break;
      }
      case "charge.refunded": {
        // charge.refunded gives us a Charge, not a Session. Resolve
        // back to our row via payment_intent — that field is set on
        // the row by markPaid(). Stripe may deliver payment_intent as
        // either a string id or an expanded PaymentIntent object
        // depending on event version / API expansion settings.
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null);
        if (paymentIntentId) {
          // Capture the structured "why" so audit consumers can answer
          // "was this admin-initiated, customer-initiated, fraud-flagged,
          // or duplicate?" without re-fetching from Stripe. Stripe's
          // canonical refund reasons are: duplicate, fraudulent,
          // requested_by_customer; null/undefined = no reason supplied
          // (typically admin-initiated through the dashboard with no
          // dropdown selection).
          const lastRefund = charge.refunds?.data?.[0];
          await markStatusByPaymentIntent(paymentIntentId, "refunded", {
            chargeId: charge.id,
            stripeEventId: event.id,
            // amount_refunded is cumulative — captures partial refunds
            // and re-refunds within the same charge correctly.
            amountRefundedCents: charge.amount_refunded,
            currency: charge.currency,
            // `reason` is per-refund; the latest refund's reason is
            // the most informative one for the audit row.
            refundReason: lastRefund?.reason ?? null,
            refundId: lastRefund?.id ?? null,
            log,
          });
        }
        break;
      }
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        // Patient self-pay flow (resupply.patient_payments) — see
        // webhook-handlers/payment-intent.ts. Events that aren't ours
        // (no metadata.patient_payment_id) are acked with no effects.
        await handlePaymentIntentEvent(event, log);
        break;
      }
      case "payment_method.detached": {
        // Saved-card hygiene — see webhook-handlers/payment-method.ts.
        await handlePaymentMethodDetached(event, log);
        break;
      }
      case "invoice.payment_failed": {
        // Subscribe & Save renewal payment failed. The companion
        // `customer.subscription.updated` event (delivered alongside)
        // already moves shop_subscriptions.status to `past_due`, so
        // the patient-facing /account page reflects this without our
        // intervention. What's NOT mirrored anywhere is the failure
        // reason (card_declined, insufficient_funds, expired_card,
        // etc.) — without it, a CSR seeing "past_due" on the dashboard
        // has to log into Stripe to find out why. Surface it as a
        // structured WARN so log alerting (Sentry / pino dashboards)
        // can route it to the billing queue without a Stripe round-trip.
        const invoice = event.data.object as Stripe.Invoice;
        const lastError = invoice.last_finalization_error ?? null;
        // Stripe SDK 22+ moved the subscription reference from
        // `invoice.subscription` (legacy) into
        // `invoice.parent.subscription_details.subscription`. Read it
        // through the new path; null-safely so non-subscription
        // invoices (one-off charges) still log cleanly.
        const subRef = invoice.parent?.subscription_details?.subscription;
        const subscriptionId =
          typeof subRef === "string" ? subRef : (subRef?.id ?? null);
        log?.warn?.(
          {
            event: "stripe_invoice_payment_failed",
            invoice_id: invoice.id,
            subscription_id: subscriptionId,
            customer_id:
              typeof invoice.customer === "string"
                ? invoice.customer
                : (invoice.customer?.id ?? null),
            amount_due_cents: invoice.amount_due,
            currency: invoice.currency,
            attempt_count: invoice.attempt_count,
            next_payment_attempt: invoice.next_payment_attempt,
            failure_code: lastError?.code ?? null,
            failure_message: lastError?.message ?? null,
          },
          "stripe: subscription renewal payment failed",
        );
        // Optional automated patient alert. The SendGrid round-trip
        // must NOT sit on the webhook's ACK path (Stripe will retry on
        // a slow response), so route through the retry-backed pg-boss
        // queue: one fast local insert here, and a transient
        // SendGrid/DB failure during the send gets retries + DLQ
        // instead of silently losing the alert after we've ACKed.
        // Gated by the `alerts.auto_dispatch` feature flag (default
        // OFF) inside the dispatcher, so this is inert until an
        // operator turns it on. When the worker isn't running (or the
        // enqueue itself fails) fall back to the historical
        // fire-and-forget direct send — degraded, but never worse than
        // the pre-queue behavior.
        {
          const alertPayload = {
            stripeCustomerId:
              typeof invoice.customer === "string"
                ? invoice.customer
                : (invoice.customer?.id ?? null),
            amountDueCents: invoice.amount_due,
            currency: invoice.currency,
          };
          const boss = getBoss();
          let enqueued = false;
          if (boss) {
            try {
              await boss.send(PAYMENT_FAILED_ALERT_JOB, alertPayload);
              enqueued = true;
            } catch (err) {
              log?.warn?.(
                { event: "payment_failed_alert_enqueue_failed", err },
                "stripe: payment_failed alert enqueue failed — falling back to direct dispatch",
              );
            }
          }
          if (!enqueued) {
            void maybeDispatchPaymentFailedAlert({ ...alertPayload, log });
          }
        }
        break;
      }
      case "charge.dispute.created": {
        // Chargeback filed by the cardholder. This is a hard-deadline
        // event (typically 7-21 days to respond depending on card
        // network) and silently ACK'ing it means losing disputes by
        // default. We don't have a dedicated disputes table yet, so
        // surface as a loud structured log line — operators with
        // alerting on `event=stripe_dispute_created` get paged
        // immediately. (A follow-up task to mirror disputes onto
        // shop_orders is tracked separately.)
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId =
          typeof dispute.charge === "string"
            ? dispute.charge
            : (dispute.charge?.id ?? null);
        log?.warn?.(
          {
            event: "stripe_dispute_created",
            dispute_id: dispute.id,
            charge_id: chargeId,
            amount_cents: dispute.amount,
            currency: dispute.currency,
            reason: dispute.reason,
            status: dispute.status,
            evidence_due_by: dispute.evidence_details?.due_by ?? null,
            is_charge_refundable: dispute.is_charge_refundable,
          },
          "stripe: chargeback dispute opened — CSR action required",
        );
        break;
      }
      case "charge.dispute.closed": {
        // Dispute outcome. Stripe sets `dispute.status` to one of
        // `won` / `lost` / `warning_closed`. The amount we lose (lost
        // disputes deduct from balance) is in dispute.amount; the
        // outcome drives ops accounting reconciliation.
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId =
          typeof dispute.charge === "string"
            ? dispute.charge
            : (dispute.charge?.id ?? null);
        log?.warn?.(
          {
            event: "stripe_dispute_closed",
            dispute_id: dispute.id,
            charge_id: chargeId,
            amount_cents: dispute.amount,
            currency: dispute.currency,
            outcome: dispute.status,
            reason: dispute.reason,
          },
          "stripe: chargeback dispute closed",
        );
        break;
      }
      default: {
        // Ack everything else — Stripe may deliver many event types we
        // don't subscribe to in the dashboard, and we don't want it
        // to retry them just because we returned non-200.
        log?.debug?.("ignoring stripe event type");
        break;
      }
    }
  } catch (err) {
    if (dedupeInserted) {
      await tryDeleteWebhookEventRecord(event.id, log);
    }
    // Capture full structured error context so a 500 here is debuggable
    // without re-running the failing event. `err` itself goes through
    // pino's default serializer (stack + cause). Stripe SDK errors
    // additionally expose statusCode / code / requestId / type / raw —
    // we surface those explicitly so an ops grep on `stripe_request_id`
    // pivots from our logs into the Stripe Dashboard. event.id and
    // event.type are already on `log`'s child context (see above).
    const stripeMeta =
      err && typeof err === "object"
        ? {
            stripe_status_code: (err as { statusCode?: unknown }).statusCode,
            stripe_code: (err as { code?: unknown }).code,
            stripe_request_id: (err as { requestId?: unknown }).requestId,
            stripe_error_type: (err as { type?: unknown }).type,
          }
        : undefined;
    log?.error?.(
      { err, ...stripeMeta },
      "stripe webhook handler threw — Stripe will retry",
    );
    res.status(500).json({ error: "internal_error" });
    return;
  }

  res.status(200).json({ received: true });
};

async function markStatusByPaymentIntent(
  paymentIntentId: string,
  _statusHint: "refunded",
  ctx: {
    chargeId: string;
    stripeEventId: string;
    amountRefundedCents: number;
    currency: string | null;
    refundReason: string | null;
    refundId: string | null;
    log:
      | {
          info?: (...args: unknown[]) => void;
          warn?: (...args: unknown[]) => void;
        }
      | undefined;
  },
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  // Resolve the order first so we can decide between partial and
  // full refund. The previous implementation wrote `status:"refunded"`
  // on EVERY charge.refunded event regardless of whether the refund
  // was for $1 or the full amount — partial refunds silently flipped
  // status, hid the order from /shop/me/orders, blocked the return
  // flow, and made the order's true paid history unrecoverable.
  const { data: existing, error: lookupErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, customer_id, amount_total_cents, status")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .limit(1);
  if (lookupErr) throw lookupErr;
  if (!existing || existing.length === 0) {
    ctx.log?.info?.(
      { paymentIntentId, matched: 0 },
      "shop order refund event for unknown payment_intent — skipping",
    );
    return;
  }
  const row = existing[0]!;
  const orderTotalCents = row.amount_total_cents ?? null;
  const isFullRefund =
    orderTotalCents !== null && ctx.amountRefundedCents >= orderTotalCents;
  const nowIso = new Date().toISOString();
  const update: ShopOrderUpdate = {
    amount_refunded_cents: ctx.amountRefundedCents,
    updated_at: nowIso,
  };
  if (isFullRefund) {
    update.status = "refunded";
  }
  // `charge.amount_refunded` is CUMULATIVE, and Stripe can redeliver /
  // reorder `charge.refunded` events (each a distinct event.id, so the
  // dedup gate lets them through). Guard the write so the mirror only
  // moves forward: a stale event carrying a lower cumulative is a no-op
  // and won't regress `amount_refunded_cents` (or un-flag a full
  // refund). The column is `NOT NULL DEFAULT 0`, so the first refund
  // (0 < incoming) still applies. Mirrors the out-of-order guard on the
  // subscription upsert above.
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update(update)
    .eq("id", row.id)
    .lt("amount_refunded_cents", ctx.amountRefundedCents)
    .select("id, customer_id");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    // Either the order's recorded cumulative refund is already >= this
    // event's (a stale/replayed lower cumulative — the monotonic guard
    // above), so there is nothing to do.
    ctx.log?.info?.(
      {
        orderId: row.id,
        amountRefundedCents: ctx.amountRefundedCents,
        orderTotalCents,
      },
      "shop order refund skipped — stale or already-recorded cumulative",
    );
    return;
  }
  ctx.log?.info?.(
    {
      matched: updated.length,
      isFullRefund,
      amountRefundedCents: ctx.amountRefundedCents,
      orderTotalCents,
    },
    isFullRefund
      ? "shop order marked refunded (full)"
      : "shop order partial-refund recorded (status unchanged)",
  );

  // Audit row carries the structured "why" so admins can later answer
  // questions like "how many refunds last month were customer-
  // requested vs fraud-flagged" without re-querying Stripe.
  // Metadata is intentionally non-PHI: amounts, currency, Stripe
  // identifiers, and the canonical refund reason — no email, no
  // shipping address, no card details.
  for (const row of updated) {
    try {
      await logAudit({
        action: "shop_order.refunded",
        targetTable: "shop_orders",
        targetId: row.id,
        adminEmail: "system:webhook:stripe",
        adminUserId: null,
        metadata: {
          stripe_event_id: ctx.stripeEventId,
          stripe_charge_id: ctx.chargeId,
          stripe_refund_id: ctx.refundId,
          stripe_payment_intent_id: paymentIntentId,
          amount_refunded_cents: ctx.amountRefundedCents,
          currency: ctx.currency,
          refund_reason: ctx.refundReason,
          customer_id: row.customer_id,
        },
      });
    } catch (err) {
      // Audit write failures are non-fatal — the DB status update is
      // the source of truth. Log so we can find systemic audit
      // outages, but don't 500 the webhook (Stripe would retry
      // forever on transient audit DB issues).
      const pgCode =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        typeof err.code === "string"
          ? err.code
          : null;
      ctx.log?.info?.(
        {
          event: "refund_audit_failed",
          errName: err instanceof Error ? err.name : typeof err,
          pgCode,
          ...(err instanceof Error ? { err } : {}),
          stripeEventId: ctx.stripeEventId,
        },
        "refund audit write failed",
      );
    }
  }
}

/**
 * Send the post-purchase confirmation email exactly once per order.
 *
 * Called after `markPaid` + `upsertOrderItemsFromSession` in the
 * checkout-completed branch. Idempotency is enforced by an ATOMIC
 * CLAIM on `shop_orders.confirmation_email_sent_at`:
 *   1. `UPDATE … SET confirmation_email_sent_at = now() WHERE id = $1
 *      AND confirmation_email_sent_at IS NULL RETURNING …` — only
 *      one worker can win the row even if Stripe fires
 *      `checkout.session.completed` and
 *      `checkout.session.async_payment_succeeded` concurrently.
 *   2. If no row was returned, another worker already claimed the
 *      send (or it was previously sent); short-circuit.
 *   3. If we won the claim, resolve recipient (linked
 *      `shop_customers.email_lower` joined on `customer_id`,
 *      falling back to `session.customer_details.email` for guests),
 *      render, and send.
 *   4. ON SEND FAILURE, RELEASE THE CLAIM by writing
 *      `confirmation_email_sent_at = NULL` so a Stripe re-delivery
 *      (or manual replay) can retry — preserving the at-most-once
 *      *successful* send while still allowing one retry per failure.
 *
 * Errors are swallowed — the caller wraps in try/catch as a second
 * line of defence. SendGrid being misconfigured or returning a 5xx
 * must NOT cause Stripe to retry the entire webhook (which would
 * re-fire markPaid + the customer/cart sync side-effects).
 */
export async function sendOrderConfirmationIfFirst(args: {
  session: Stripe.Checkout.Session;
  paidOrderId: string;
  items: readonly OrderConfirmationLineItem[];
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined;
}): Promise<
  { skipped: true; reason: string } | { skipped: false; delivered: boolean }
> {
  const { session, paidOrderId, items, log } = args;
  const supabase = getSupabaseServiceRoleClient();

  // Atomic claim: stamp the timestamp ONLY if it is currently NULL.
  // The RETURNING gives back the canonical row fields the email needs
  // (avoiding a separate SELECT). If `claimed` is undefined either
  // (a) the row doesn't exist or (b) another worker already stamped.
  // Both are "skip" outcomes for this send.
  const nowIso = new Date().toISOString();
  const { data: claimedRows, error: claimErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update({
      confirmation_email_sent_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", paidOrderId)
    .is("confirmation_email_sent_at", null)
    .select(
      "id, stripe_session_id, customer_id, amount_total_cents, currency, shipping_address_json, customer_email",
    );
  if (claimErr) throw claimErr;
  const claimed = claimedRows?.[0];

  if (!claimed) {
    log?.info?.(
      { orderId: paidOrderId },
      "order confirmation email skipped — already sent or row missing",
    );
    return { skipped: true, reason: "already_sent_or_missing" };
  }

  // From here on, ANY failure path MUST release the claim by writing
  // confirmation_email_sent_at = NULL so a future redelivery can retry.
  // Idempotent: safe to call multiple times (sets stamp back to NULL).
  // The outer try/catch below guarantees release on ANY thrown error
  // anywhere in the post-claim block — including transient DB errors
  // during the customer lookup — so a transient failure can never
  // permanently lock out the email.
  const releaseClaim = async (): Promise<void> => {
    try {
      const { error: releaseErr } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .update({
          confirmation_email_sent_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimed.id);
      if (releaseErr) throw releaseErr;
    } catch (releaseErr) {
      log?.warn?.(
        {
          orderId: claimed.id,
          err:
            releaseErr instanceof Error
              ? releaseErr.message
              : String(releaseErr),
        },
        "order confirmation email claim release failed",
      );
    }
  };

  try {
    // Recipient resolution: linked customer first, persisted
    // `customer_email` (captured at paid-time) next, Stripe Session
    // fallback last. We never log any of these values.
    let toEmail: string | null = null;
    if (claimed.customer_id) {
      const { data: cust, error: custErr } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("email_lower")
        .eq("customer_id", claimed.customer_id)
        .maybeSingle();
      if (custErr) throw custErr;
      if (cust?.email_lower) toEmail = cust.email_lower;
    }
    if (!toEmail && claimed.customer_email) {
      toEmail = claimed.customer_email;
    }
    if (!toEmail) {
      const sessionEmail = session.customer_details?.email?.trim();
      if (sessionEmail) toEmail = sessionEmail.toLowerCase();
    }
    if (!toEmail) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimed.id },
        "order confirmation email skipped — no recipient on file",
      );
      return { skipped: true, reason: "no_email_on_file" };
    }

    const result = await sendOrderConfirmationEmail({
      toEmail,
      stripeSessionId: claimed.stripe_session_id,
      items,
      amountTotalCents: claimed.amount_total_cents ?? session.amount_total ?? 0,
      currency: claimed.currency ?? session.currency ?? "usd",
      shippingAddress:
        (claimed.shipping_address_json as unknown as SavedShippingAddress | null) ??
        null,
    });

    if (!result.configured) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimed.id },
        "order confirmation email skipped — sendgrid not configured",
      );
      return { skipped: true, reason: "not_configured" };
    }
    if (!result.delivered) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimed.id, error: result.error },
        "order confirmation email send failed (non-fatal, claim released)",
      );
      return { skipped: false, delivered: false };
    }

    log?.info?.(
      { orderId: claimed.id, messageId: result.messageId ?? null },
      "order confirmation email delivered",
    );
    return { skipped: false, delivered: true };
  } catch (err) {
    // Catch-all: ANY uncaught error after the claim acquisition
    // (transient DB read failure, unexpected throw inside the email
    // helper, etc.) must release the claim so the next webhook
    // redelivery can retry — otherwise a single transient failure
    // would permanently suppress the confirmation email.
    await releaseClaim();
    log?.warn?.(
      {
        orderId: claimed.id,
        err,
      },
      "order confirmation email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}
