// payment_intent.* event family — patient self-pay flow
// (resupply.patient_payments).
//
// We identify our row via metadata.patient_payment_id — set by
// createPaymentIntent() in lib/billing/patient-payment.ts. Stripe
// payments related to shop_orders flow through the checkout.session.*
// events; this family is dedicated to portal balance payments.

import type Stripe from "stripe";

/**
 * Handle payment_intent.succeeded / .payment_failed / .canceled.
 * Events without our `patient_payment_id` metadata are not ours —
 * acked by the caller with no side effects.
 */
export async function handlePaymentIntentEvent(
  event: Stripe.Event,
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const intent = event.data.object as Stripe.PaymentIntent;
  const patientPaymentId =
    typeof intent.metadata?.patient_payment_id === "string"
      ? intent.metadata.patient_payment_id
      : null;
  if (!patientPaymentId) {
    // Not one of ours — ack and move on.
    return;
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
    await import("../../billing/patient-payment.js");
  await markPaymentStatus({
    paymentId: patientPaymentId,
    status,
    failureReason,
  });
  log?.info?.(
    { patientPaymentId, status },
    "patient_payment: status updated by webhook",
  );
}
