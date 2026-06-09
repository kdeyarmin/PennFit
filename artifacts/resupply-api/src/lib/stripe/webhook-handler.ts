// Stripe webhook handler — verifies signature, dispatches events to
// the local shop_orders mirror.
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
import { z } from "zod";
import type Stripe from "stripe";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
  type ShopSubscriptionItemSnapshot,
} from "@workspace/resupply-db";

import type { SavedShippingAddress } from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";

type ShopOrderUpdate = Database["resupply"]["Tables"]["shop_orders"]["Update"];
type ShopOrderItemInsert =
  Database["resupply"]["Tables"]["shop_order_items"]["Insert"];
type ShopCustomerInsert =
  Database["resupply"]["Tables"]["shop_customers"]["Insert"];
type ShopCustomerUpdate =
  Database["resupply"]["Tables"]["shop_customers"]["Update"];
type ShopSubscriptionUpdate =
  Database["resupply"]["Tables"]["shop_subscriptions"]["Update"];

import { maybeDispatchPaymentFailedAlert } from "../alerts/payment-failed-trigger";
import {
  getStripeClient,
  readStripeConfigOrNull,
  type StripeConfig,
} from "./config";
import { readDefaultPaymentMethod } from "./customer";
import { formatIntervalLabel } from "./products-meta";
import {
  sendOrderConfirmationEmail,
  type OrderConfirmationLineItem,
} from "../order-emails/send-order-confirmation-email";
import { tryAutoEnrollReminderFromOrder } from "../storefront/order-reminder-enrollment";
import {
  fetchUnitCostsBySku,
  stampUnitCostSnapshots,
} from "../billing/product-cost-lookup";

/**
 * Pull our shop-customer id out of Stripe metadata. The mapping
 * lives under `metadata.customer_id` for every Session / Subscription /
 * Customer this codebase creates. Returns null when the key is
 * absent or empty.
 */
function readCustomerIdFromMetadata(
  meta: Stripe.Metadata | null | undefined,
): string | null {
  if (!meta) return null;
  if (typeof meta.customer_id === "string" && meta.customer_id) {
    return meta.customer_id;
  }
  return null;
}

/**
 * Zod schema for the legacy `session.shipping_details` field shape.
 * This fallback exists for older/backlogged Stripe webhook events
 * that predate `collected_information.shipping_details`. The schema
 * replaces the prior `as unknown as {...}` cast so a structural
 * change on Stripe's side surfaces as a parse failure (null address)
 * rather than silently propagating undefined field access.
 */
const LegacyShippingDetailsSchema = z
  .object({
    shipping_details: z
      .object({
        address: z
          .object({
            line1: z.string().nullable().optional(),
            line2: z.string().nullable().optional(),
            city: z.string().nullable().optional(),
            state: z.string().nullable().optional(),
            postal_code: z.string().nullable().optional(),
            country: z.string().nullable().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * Extract a shipping address from a Checkout Session into our
 * canonical SavedShippingAddress shape, or return null if the
 * session didn't collect one (or collected an obviously incomplete
 * address — e.g. line1 missing).
 *
 * Why we tolerate two different field locations:
 *   - The current Stripe API returns shipping under
 *     `session.collected_information.shipping_details`.
 *   - Older / legacy events delivered it directly at
 *     `session.shipping_details`.
 *   Stripe's TS types only surface the former; we validate the
 *   latter through Zod so a Stripe-side rename surfaces as null
 *   (graceful degradation) instead of a runtime crash.
 *
 * Why we always write country: "US":
 *   The shop is US-only by current product policy. Stripe will only
 *   ever return a US address (we restrict at Checkout config time).
 *   Hardcoding the literal here matches the SavedShippingAddress
 *   `country: "US"` literal type so consumers never have to guard.
 */
export function extractShippingAddressFromSession(
  session: Stripe.Checkout.Session,
): SavedShippingAddress | null {
  const primary = session.collected_information?.shipping_details;
  const legacyParsed = LegacyShippingDetailsSchema.safeParse(session);
  const legacy = legacyParsed.success
    ? legacyParsed.data.shipping_details
    : undefined;
  const shipping = primary ?? legacy ?? null;
  const addr = shipping?.address;
  // Required-field gate — a half-filled address (e.g. only line1) is
  // worse than none, because the customer-facing UI would render the
  // partial value as if it were authoritative.
  if (!addr?.line1 || !addr.city || !addr.state || !addr.postal_code) {
    return null;
  }
  return {
    line1: addr.line1,
    line2: addr.line2 ?? null,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postal_code,
    country: "US",
  };
}

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
      { err: err instanceof Error ? err.message : String(err) },
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
      { err: err instanceof Error ? err.message : String(err) },
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
          const { recordAutopayAuthorization } = await import(
            "../billing/patient-autopay.js"
          );
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
        // Subscribe & Save mirror. The patient-facing /account UI
        // reads from shop_subscriptions; Stripe stays the billing
        // source of truth. We upsert on stripe_subscription_id so
        // out-of-order delivery (created arriving after updated)
        // doesn't double-insert. The upsert is gated on
        // last_stripe_event_at so a replayed/late event can never
        // overwrite newer state — see upsertSubscription for the
        // ordering guard.
        const subscription = event.data.object as Stripe.Subscription;
        const eventCreatedAt = new Date(event.created * 1000);
        await upsertSubscription(subscription, eventCreatedAt, log);
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
        // Patient self-pay flow (resupply.patient_payments). We
        // identify our row via metadata.patient_payment_id — set by
        // createPaymentIntent() in lib/billing/patient-payment.ts.
        // Stripe payments related to shop_orders flow through the
        // checkout.session.* events above; this branch is dedicated
        // to portal balance payments.
        const intent = event.data.object as Stripe.PaymentIntent;
        const patientPaymentId =
          typeof intent.metadata?.patient_payment_id === "string"
            ? intent.metadata.patient_payment_id
            : null;
        if (!patientPaymentId) {
          // Not one of ours — ack and move on.
          break;
        }
        const status =
          event.type === "payment_intent.succeeded"
            ? "succeeded"
            : event.type === "payment_intent.canceled"
              ? "cancelled"
              : "failed";
        const failureReason =
          event.type === "payment_intent.payment_failed"
            ? (intent.last_payment_error?.message ?? "payment failed")
            : null;
        const { markPaymentStatus } =
          await import("../billing/patient-payment.js");
        await markPaymentStatus({
          paymentId: patientPaymentId,
          status,
          failureReason,
        });
        log?.info?.(
          { patientPaymentId, status },
          "patient_payment: status updated by webhook",
        );
        break;
      }
      case "payment_method.detached": {
        // Customer removed a card from Stripe Customer Portal.
        // Without this branch our `shop_customers.default_payment_method_*`
        // columns continue pointing at the detached PM, and the
        // /account page would render a card that no longer exists +
        // any off-session charge attempt 4xx's. Clear the pointer
        // when (and only when) the detached PM id matches our stored
        // default — a previously-rotated PM that's no longer ours
        // shouldn't disturb a freshly-set default.
        const pm = event.data.object as Stripe.PaymentMethod;
        if (typeof pm.id === "string") {
          const supabase = getSupabaseServiceRoleClient();
          const { error: clearErr } = await supabase
            .schema("resupply")
            .from("shop_customers")
            .update({
              default_payment_method_id: null,
              default_payment_method_brand: null,
              default_payment_method_last4: null,
              default_payment_method_exp_month: null,
              default_payment_method_exp_year: null,
            })
            .eq("default_payment_method_id", pm.id);
          if (clearErr) {
            log?.warn?.(
              { err: clearErr.message, paymentMethodId: pm.id },
              "shop_customers: default-PM clear on detach failed",
            );
          } else {
            log?.info?.(
              { paymentMethodId: pm.id },
              "shop_customers: cleared default PM on detach",
            );
          }
          // Also revoke any patient autopay authorization pointing at this
          // card so the worker never tries to charge a card the patient
          // removed via Stripe's own Customer Portal. Best-effort — a
          // failure here must not 500 the webhook.
          try {
            const { clearAutopayByPaymentMethod } = await import(
              "../billing/patient-autopay.js"
            );
            await clearAutopayByPaymentMethod(pm.id, log);
          } catch (autopayErr) {
            log?.warn?.(
              {
                err:
                  autopayErr instanceof Error
                    ? autopayErr.message
                    : String(autopayErr),
                paymentMethodId: pm.id,
              },
              "patient autopay: revoke on PM detach failed (non-fatal)",
            );
          }
        }
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
        // Optional automated patient alert. Fire-and-forget — the
        // SendGrid round-trip must NOT sit on the webhook's ACK path
        // (Stripe will retry on a slow response). Gated by the
        // `alerts.auto_dispatch` feature flag (default OFF), so this is
        // inert until an operator turns it on. Resolution + send + all
        // error handling live in the trigger module; we don't await.
        void maybeDispatchPaymentFailedAlert({
          stripeCustomerId:
            typeof invoice.customer === "string"
              ? invoice.customer
              : (invoice.customer?.id ?? null),
          amountDueCents: invoice.amount_due,
          currency: invoice.currency,
          log,
        });
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

/**
 * Complete a payment-plan autopay authorization (mode=setup Checkout).
 * Stores the Stripe customer + the mandated payment method on the plan
 * and flips autopay_status='authorized'. The payment method is read from
 * the session's SetupIntent. Idempotent — re-delivery re-writes the same
 * values. Storing a card off-session here is what later lets the
 * autocharge worker debit it (still gated by the seeded-OFF flag + cron).
 */
async function authorizePaymentPlanAutopay(
  config: StripeConfig,
  session: Stripe.Checkout.Session,
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const planId = session.metadata?.payment_plan_id;
  if (!planId) return;
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer?.id ?? null);

  // Resolve the payment method from the SetupIntent.
  const stripe = getStripeClient(config);
  const setupIntentId =
    typeof session.setup_intent === "string"
      ? session.setup_intent
      : (session.setup_intent?.id ?? null);
  let paymentMethodId: string | null = null;
  if (setupIntentId) {
    const si = await stripe.setupIntents.retrieve(setupIntentId);
    paymentMethodId =
      typeof si.payment_method === "string"
        ? si.payment_method
        : (si.payment_method?.id ?? null);
  }
  if (!customerId || !paymentMethodId) {
    log?.info?.(
      {
        planId,
        hasCustomer: Boolean(customerId),
        hasPm: Boolean(paymentMethodId),
      },
      "stripe webhook: autopay setup completed but customer/PM missing — not authorizing",
    );
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema("resupply")
    .from("patient_payment_plans")
    .update({
      autopay_status: "authorized",
      stripe_customer_id: customerId,
      stripe_payment_method_id: paymentMethodId,
      autopay_authorized_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", planId);
  if (error) throw error;
  log?.info?.({ planId }, "stripe webhook: payment-plan autopay authorized");
}

interface PaidOrderRow {
  id: string;
  customerId: string | null;
  paidAt: Date;
}

async function markPaid(
  session: Stripe.Checkout.Session,
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<PaidOrderRow | null> {
  const supabase = getSupabaseServiceRoleClient();
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  // Re-stamp customer_id from session metadata. The route that
  // created this Session also wrote it locally — this is belt-and-
  // suspenders in case the local write was lost (crash mid-request,
  // sequencing issue, etc.).
  const customerId = readCustomerIdFromMetadata(session.metadata);

  // Fulfillment method + pickup location, set by routes/shop/checkout.ts
  // into the session metadata. Default to 'ship' for any older session
  // (pre-pickup) or one missing the field. A 'pickup' order never
  // collected a shipping address (checkout omits the prompt), so the
  // snapshot below stays null and the order runs the pickup lifecycle.
  const fulfillmentMethod =
    session.metadata?.fulfillment_method === "pickup" ? "pickup" : "ship";
  const pickupLocationId =
    fulfillmentMethod === "pickup"
      ? (session.metadata?.pickup_location_id ?? null)
      : null;

  // Per-order shipping address snapshot (W3 T-C7). Reading from the
  // session at paid-time captures the address-as-shipped, which is
  // the right semantics for the customer-facing order history and
  // the admin tracking workflow — even if the shop_customers default
  // address is later edited. Falls back to null when the session
  // didn't collect shipping (shipping-disabled SKUs, etc); the
  // admin "edit address" endpoint can fill it in later.
  const shippingAddress = extractShippingAddressFromSession(session);

  // Capture the buyer's email at paid-time. Lower-cased to match the
  // shop_customers.email_lower convention used elsewhere. We persist
  // this on the order row (rather than chasing the Stripe Session
  // again at admin-shipping time) so guest checkouts can still
  // receive shipping notifications. See migration 0017.
  const sessionEmailRaw = session.customer_details?.email?.trim();
  const customerEmail = sessionEmailRaw ? sessionEmailRaw.toLowerCase() : null;

  const nowIso = new Date().toISOString();
  const update: ShopOrderUpdate = {
    status: "paid",
    stripe_payment_intent_id: paymentIntentId,
    amount_total_cents: session.amount_total ?? null,
    currency: session.currency ?? null,
    paid_at: nowIso,
    updated_at: nowIso,
    fulfillment_method: fulfillmentMethod,
  };
  if (customerId) update.customer_id = customerId;
  // Persist the pickup location for pickup orders. Leave the column
  // untouched on ship orders so a webhook re-delivery can't null out a
  // value (the checkout route already wrote it on the pending row).
  if (pickupLocationId) update.pickup_location_id = pickupLocationId;
  // Only write the snapshot if Stripe actually gave us one. Skipping
  // the key on null preserves any later admin edit on a Stripe
  // re-delivery (charge.refunded → no shipping_details).
  if (shippingAddress) {
    update.shipping_address_json = shippingAddress as unknown as Json;
  }
  if (customerEmail) update.customer_email = customerEmail;

  // Upsert (not bare UPDATE). The previous UPDATE silently matched
  // zero rows when `checkout.ts` crashed after creating the Stripe
  // session but before persisting the local `shop_orders` row — the
  // webhook handler would then return 200 and Stripe would never
  // retry, permanently losing a paid order from local history.
  // Upserting on `stripe_session_id` records the order from the
  // webhook even when the route-side write was lost; if checkout.ts
  // later writes the row, the conflict resolves cleanly.
  const upsertRow: ShopOrderUpdate & { stripe_session_id: string } = {
    ...update,
    stripe_session_id: session.id,
  };
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .upsert(upsertRow, { onConflict: "stripe_session_id" })
    .select("id, customer_id, paid_at");
  if (error) throw error;

  log?.info?.({ amountCents: session.amount_total }, "shop order marked paid");

  const row = rows?.[0];
  if (!row) {
    // Should be unreachable after the upsert above (the row either
    // existed and was updated, or didn't and was inserted). Log loud
    // so an operator can investigate if it ever fires.
    log?.info?.(
      { sessionId: session.id },
      "shop order markPaid: upsert returned no row — investigate",
    );
    return null;
  }
  return {
    id: row.id,
    customerId: row.customer_id,
    // paid_at was just set to nowIso above and is non-null on the
    // returned row.
    paidAt: row.paid_at ? new Date(row.paid_at) : new Date(),
  };
}

/**
 * Mirror the line items on a paid Checkout Session into
 * shop_order_items so the verified-purchaser badge and the
 * /shop/me/orders history page can answer "did this user buy this
 * product?" with one indexed lookup instead of N Stripe round-trips.
 *
 * One Stripe API call per webhook invocation (listLineItems with
 * expand=data.price.product). The parent shop_orders row already has
 * status='paid' by the time we run, so even if this fails the order
 * is fully recognised; missing items just cause the verified pill
 * not to show until a Stripe re-delivery (or a manual replay) fills
 * them in.
 *
 * Idempotent: the (stripe_session_id, product_id, price_id) UNIQUE
 * + onConflictDoNothing absorbs both Stripe re-deliveries AND the
 * checkout.session.completed/async_payment_succeeded twin firing
 * for the same session.
 */
async function upsertOrderItemsFromSession(
  config: StripeConfig,
  session: Stripe.Checkout.Session,
  order: PaidOrderRow,
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<OrderConfirmationLineItem[]> {
  const stripe = getStripeClient(config);
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ["data.price.product"],
  });

  const rows: ShopOrderItemInsert[] = [];
  // SKU per row (aligned 1:1 with `rows`), resolved from the expanded
  // Stripe product metadata, for the COGS snapshot lookup below.
  const rowSkus: (string | null)[] = [];
  // Built alongside `rows` so the email can reuse the line items we
  // just paid Stripe a single round-trip to fetch — instead of
  // making the same expanded listLineItems call again from the email
  // helper. Product names are deliberately NOT mirrored into
  // shop_order_items (see schema comment), so the email path picks
  // them up here from the live Stripe catalog rendering.
  const emailItems: OrderConfirmationLineItem[] = [];
  const paidAtIso = order.paidAt.toISOString();
  for (const li of lineItems.data) {
    const price = li.price ?? null;
    const product = price?.product ?? null;
    const productId =
      typeof product === "string"
        ? product
        : product && !product.deleted
          ? product.id
          : null;
    if (!productId) {
      // No way to attribute this row to a product — skip rather than
      // insert an opaque entry that the verified-purchaser join can't
      // use. Recoverable: a future enrichment job can backfill.
      continue;
    }
    rows.push({
      order_id: order.id,
      stripe_session_id: session.id,
      customer_id: order.customerId,
      product_id: productId,
      // Use '' (not null) so the (stripe_session_id, product_id,
      // price_id) UNIQUE actually dedupes redeliveries — Postgres
      // UNIQUE treats NULLs as distinct. Schema enforces NOT NULL
      // with default '' (migration 0011).
      price_id: price?.id ?? "",
      quantity: li.quantity ?? 1,
      unit_amount_cents: price?.unit_amount ?? null,
      currency: price?.currency ?? null,
      paid_at: paidAtIso,
    });

    // Resolve the shop SKU from the expanded Stripe product metadata
    // (written by seed-stripe-products). Aligned 1:1 with `rows` so the
    // COGS snapshot lookup below can stamp by index.
    let sku: string | null = null;
    if (product && typeof product === "object" && !product.deleted) {
      const raw = product.metadata.shop_sku;
      if (typeof raw === "string" && raw.trim().length > 0) sku = raw.trim();
    }
    rowSkus.push(sku);

    // Stripe gives us a description on the LineItem itself (matches
    // what the customer saw in Hosted Checkout). Fall back to the
    // expanded product name if for some reason description is empty.
    const productName =
      product && typeof product === "object" && !product.deleted
        ? product.name
        : null;
    const displayName = li.description?.trim() || productName?.trim() || "Item";
    emailItems.push({
      name: displayName,
      quantity: li.quantity ?? 1,
      unitAmountCents: price?.unit_amount ?? 0,
      currency: price?.currency ?? "usd",
    });
  }

  if (rows.length === 0) {
    log?.info?.(
      { sessionId: session.id },
      "stripe webhook: no insertable line items for session",
    );
    return emailItems;
  }

  // Stamp the per-unit COGS snapshot (migration 0193) so a later cost
  // change never rewrites this order's margin. Fail-soft:
  // fetchUnitCostsBySku returns an empty map on any error, leaving cost
  // null ("unknown") — it must never block the order-items write.
  const costBySku = await fetchUnitCostsBySku(rowSkus, log);
  stampUnitCostSnapshots(rows, rowSkus, costBySku, paidAtIso);

  const supabase = getSupabaseServiceRoleClient();
  // ON CONFLICT DO NOTHING for the (stripe_session_id, product_id,
  // price_id) UNIQUE — supabase-js exposes this as upsert with
  // ignoreDuplicates: true.
  const { error } = await supabase
    .schema("resupply")
    .from("shop_order_items")
    .upsert(rows, {
      onConflict: "stripe_session_id,product_id,price_id",
      ignoreDuplicates: true,
    });
  if (error) throw error;

  log?.info?.(
    { sessionId: session.id, count: rows.length },
    "shop_order_items upserted",
  );
  return emailItems;
}

/**
 * Sync the buyer's saved card + shipping address back to
 * shop_customers so the next /shop/me render includes the freshly
 * saved details. Runs only when the Session has both a
 * `customer_id` in metadata AND a `customer` attached.
 *
 * Order of operations:
 *   1. Best-effort: read the Customer's default payment method and
 *      persist its display crumbs (brand/last4/exp).
 *   2. Best-effort: persist Stripe's collected shipping_details as
 *      our default address — but only if the user doesn't already
 *      have one (don't clobber an explicit /shop/me edit with an
 *      auto-collected one).
 */
export async function syncCustomerAfterCheckout(
  config: StripeConfig,
  session: Stripe.Checkout.Session,
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const customerId = readCustomerIdFromMetadata(session.metadata);
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer?.id ?? null);
  if (!customerId || !stripeCustomerId) return;

  const supabase = getSupabaseServiceRoleClient();

  const dpm = await readDefaultPaymentMethod(config, stripeCustomerId);
  const shippingAddress = extractShippingAddressFromSession(session);
  // Stripe collects the phone at Checkout (phone_number_collection); it
  // arrives on the completed session's customer_details. Persist it so an
  // inbound voice caller can be matched to this storefront account.
  const phoneRaw = session.customer_details?.phone ?? null;
  const phoneE164 = phoneRaw ? normalizeE164(phoneRaw) : null;

  // Read existing row to decide whether to backfill the shipping address
  // and phone (only when empty — never overwrite a deliberate edit).
  const { data: existing, error: selectErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("shipping_address_json, stripe_customer_id, phone_e164")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (selectErr) throw selectErr;

  const shouldSetShipping =
    shippingAddress !== null &&
    (existing?.shipping_address_json ?? null) === null;
  const shouldSetPhone =
    phoneE164 !== null && (existing?.phone_e164 ?? null) === null;

  const nowIso = new Date().toISOString();

  if (!existing) {
    // First-time row — INSERT with the full snapshot. Use upsert with
    // onConflict: customer_id so a concurrent inserter (e.g. another
    // webhook redelivery) folds into UPDATE rather than 23505-throwing.
    const insertRow: ShopCustomerInsert = {
      customer_id: customerId,
      stripe_customer_id: stripeCustomerId,
      default_payment_method_id: dpm?.id ?? null,
      default_payment_method_brand: dpm?.brand ?? null,
      default_payment_method_last4: dpm?.last4 ?? null,
      default_payment_method_exp_month: dpm?.expMonth ?? null,
      default_payment_method_exp_year: dpm?.expYear ?? null,
      shipping_address_json: shippingAddress
        ? (shippingAddress as unknown as Json)
        : null,
      phone_e164: phoneE164,
      updated_at: nowIso,
    };
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .upsert(insertRow, { onConflict: "customer_id" });
    if (insertErr) throw insertErr;
  } else {
    // Existing row — partial UPDATE. Only set keys we have values for,
    // and only set shipping_address_json when the existing one is null
    // (preserves explicit /shop/me edits).
    const updates: ShopCustomerUpdate = { updated_at: nowIso };
    if (!existing.stripe_customer_id) {
      updates.stripe_customer_id = stripeCustomerId;
    }
    if (dpm) {
      updates.default_payment_method_id = dpm.id;
      updates.default_payment_method_brand = dpm.brand;
      updates.default_payment_method_last4 = dpm.last4;
      updates.default_payment_method_exp_month = dpm.expMonth;
      updates.default_payment_method_exp_year = dpm.expYear;
    }
    if (shouldSetShipping && shippingAddress) {
      updates.shipping_address_json = shippingAddress as unknown as Json;
    }
    if (shouldSetPhone && phoneE164) {
      updates.phone_e164 = phoneE164;
    }
    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .update(updates)
      .eq("customer_id", customerId);
    if (updateErr) throw updateErr;
  }

  log?.info?.(
    {
      customerId,
      hasCard: !!dpm,
      savedShipping: shouldSetShipping,
      savedPhone: shouldSetPhone,
    },
    "shop customer synced after checkout",
  );
}

/**
 * Mark the abandoned-cart row for this auth user as recovered so the
 * dispatcher never nudges a customer who already converted. Called
 * from `checkout.session.completed`.
 *
 * Idempotent and safe to call when no row exists — the WHERE clause
 * filters on `recovered_at IS NULL` so a double-fire from Stripe (the
 * "completed" + "async_payment_succeeded" pair both flow through the
 * same case) is a no-op the second time. We zero out items and
 * subtotal so a stale items list cannot leak into a future "we
 * restored your cart from the email" rehydration after the purchase.
 *
 * Guest checkouts (no `customer_id` in session metadata) are a
 * no-op — there's no abandoned-cart row to update because guests
 * never write one.
 */
export async function markCartRecovered(
  session: Stripe.Checkout.Session,
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const customerId = readCustomerIdFromMetadata(session.metadata);
  if (!customerId) return;
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .update({
      recovered_at: nowIso,
      items: [] as unknown as Json,
      subtotal_cents: 0,
      updated_at: nowIso,
    })
    .eq("customer_id", customerId)
    .is("recovered_at", null)
    .select("id");
  if (error) throw error;
  if (updated && updated.length > 0) {
    log?.info?.(
      { customerId, rowId: updated[0]!.id },
      "abandoned cart marked recovered",
    );
  }
}

async function markStatus(
  sessionId: string,
  status: "expired" | "failed",
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  // Filter on current status. A late-arriving `checkout.session.expired`
  // (Stripe redelivery, out-of-order webhook) MUST NOT demote a row
  // that was already paid or refunded — that would hide the order
  // from /shop/me/orders, block the return flow, and corrupt the
  // refund pipeline. Allowed transitions only: pending → expired |
  // failed.
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("stripe_session_id", sessionId)
    .eq("status", "pending")
    .select("id, status");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    log?.warn?.(
      { sessionId, attemptedStatus: status },
      "shop order status update skipped — row not in pending state (late or out-of-order event)",
    );
    return;
  }
  log?.info?.({ status, count: updated.length }, "shop order status updated");
}

/**
 * Upsert one customer.subscription.* event into shop_subscriptions.
 *
 * The shop customer id is recovered from the subscription's
 * metadata (stamped at Session creation time in checkout.ts).
 * If it's missing — which can happen for legacy subscriptions or
 * for events Stripe emits without our prior context — we still
 * insert the row with a synthetic placeholder so we don't lose
 * the Stripe-side source of truth, but log a warning. The
 * /shop/me/subscriptions endpoint filters by customer_id, so an
 * unowned row won't accidentally surface to the wrong patient.
 */
async function upsertSubscription(
  subscription: Stripe.Subscription,
  eventCreatedAt: Date,
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();

  const customerId = readCustomerIdFromMetadata(subscription.metadata);
  if (!customerId) {
    // Previously this branch stored the row with `customer_id =
    // "__unknown"`. That collides across unrelated subscriptions
    // that all share the sentinel value, and lets an admin query
    // on `customer_id = "__unknown"` return cross-tenant data.
    // Drop the row entirely instead — surfacing the missing-
    // metadata case loudly in logs is more useful than a poisoned
    // shop_subscriptions table. Operators can backfill from Stripe
    // by event id if the subscription is genuinely ours.
    log?.warn?.(
      {
        subscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
      },
      "stripe subscription event missing customer_id metadata — dropping (no synthetic placeholder)",
    );
    return;
  }

  const stripeCustomerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : (subscription.customer?.id ?? null);

  // Snapshot line items for offline rendering on /account.
  const items: ShopSubscriptionItemSnapshot[] = subscription.items.data.map(
    (it) => {
      const price = it.price;
      const product = price.product;
      const productId =
        typeof product === "string" ? product : (product?.id ?? null);
      const productName =
        typeof product === "object" && product && !product.deleted
          ? product.name
          : null;
      const interval = price.recurring?.interval ?? null;
      const intervalCount = price.recurring?.interval_count ?? null;
      return {
        priceId: price.id,
        productId,
        quantity: it.quantity ?? 1,
        name: productName,
        unitAmountCents: price.unit_amount ?? null,
        currency: price.currency ?? null,
        intervalLabel:
          interval && intervalCount
            ? formatIntervalLabel(
                interval as "day" | "week" | "month" | "year",
                intervalCount,
              )
            : null,
      };
    },
  );

  // Stripe stores billing-period boundaries on each subscription
  // item (since 2025-11-05 the top-level current_period_end was
  // moved to per-item). Take the earliest item period_end so the
  // /account UI can render "next ship" honestly when an item ships
  // sooner than its siblings.
  const periodEndUnix = subscription.items.data.reduce<number | null>(
    (acc, it) => {
      const value = (it as unknown as { current_period_end?: number | null })
        .current_period_end;
      if (typeof value !== "number") return acc;
      if (acc === null) return value;
      return Math.min(acc, value);
    },
    null,
  );
  const currentPeriodEnd =
    periodEndUnix !== null ? new Date(periodEndUnix * 1000) : null;

  const canceledAt =
    typeof subscription.canceled_at === "number"
      ? new Date(subscription.canceled_at * 1000)
      : null;

  // Out-of-order / replay protection: only update when the incoming
  // event is at least as new as the last one we applied. Stripe can
  // legally re-deliver any event for up to 30 days, so a stale
  // `created` arriving after a real `deleted` would otherwise revive
  // a canceled subscription in our mirror. The first event for a
  // given subscription always wins (last_stripe_event_at IS NULL).
  // We compare on `event.created` (seconds-resolution Unix time);
  // ties allow the write through so a same-second cluster updates
  // monotonically.
  //
  // PostgREST has no `ON CONFLICT DO UPDATE WHERE`, so we attempt the
  // INSERT first; on 23505 we fall back to a conditional UPDATE
  // guarded by `last_stripe_event_at IS NULL OR <= eventCreatedAt`.
  const eventCreatedAtIso = eventCreatedAt.toISOString();
  const periodEndIso = currentPeriodEnd ? currentPeriodEnd.toISOString() : null;
  const canceledAtIso = canceledAt ? canceledAt.toISOString() : null;
  const itemsJson = items as unknown as Json;

  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("shop_subscriptions")
    .insert({
      customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: stripeCustomerId,
      status: subscription.status,
      items: itemsJson,
      current_period_end: periodEndIso,
      cancel_at_period_end: subscription.cancel_at_period_end ?? false,
      canceled_at: canceledAtIso,
      initial_amount_total_cents: null,
      last_stripe_event_at: eventCreatedAtIso,
    });
  if (!insertErr) {
    log?.info?.(
      {
        subscriptionId: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
      "shop_subscriptions upserted",
    );
    return;
  }
  if ((insertErr as { code?: string }).code !== "23505") {
    throw insertErr;
  }

  // Conflict — conditional UPDATE with the ordering guard.
  const update: ShopSubscriptionUpdate = {
    stripe_customer_id: stripeCustomerId,
    status: subscription.status,
    items: itemsJson,
    current_period_end: periodEndIso,
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    canceled_at: canceledAtIso,
    last_stripe_event_at: eventCreatedAtIso,
    updated_at: new Date().toISOString(),
  };
  // Don't overwrite a known customer_id with __unknown — the creation
  // event always carries it; later updates may come from system
  // events (e.g. invoice retry) that may not.
  if (customerId) update.customer_id = customerId;

  const { data: updated, error: updateErr } = await supabase
    .schema("resupply")
    .from("shop_subscriptions")
    .update(update)
    .eq("stripe_subscription_id", subscription.id)
    .or(
      `last_stripe_event_at.is.null,last_stripe_event_at.lte.${eventCreatedAtIso}`,
    )
    .select("id");
  if (updateErr) throw updateErr;

  if (!updated || updated.length === 0) {
    log?.warn?.(
      {
        subscriptionId: subscription.id,
        status: subscription.status,
        eventCreatedAt: eventCreatedAtIso,
      },
      "shop_subscriptions upsert skipped — stale or replayed event",
    );
    return;
  }

  log?.info?.(
    {
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
    "shop_subscriptions upserted",
  );
}

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
        err: err instanceof Error ? err.message : String(err),
      },
      "order confirmation email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}
