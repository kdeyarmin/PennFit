// payment_method.detached event family — saved-card hygiene.
//
// Customer removed a card from Stripe Customer Portal. Without this
// handler our `shop_customers.default_payment_method_*` columns
// continue pointing at the detached PM, and the /account page would
// render a card that no longer exists + any off-session charge
// attempt 4xx's.

import type Stripe from "stripe";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

/**
 * Handle payment_method.detached: clear the stored default-PM pointer
 * when (and only when) the detached PM id matches our stored default —
 * a previously-rotated PM that's no longer ours shouldn't disturb a
 * freshly-set default. Also revokes any patient autopay authorization
 * pointing at the card (best-effort).
 */
export async function handlePaymentMethodDetached(
  event: Stripe.Event,
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
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
      const { clearAutopayByPaymentMethod } =
        await import("../../billing/patient-autopay.js");
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
}
