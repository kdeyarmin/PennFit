// Automated `payment_failed` alert trigger.
//
// Fired (fire-and-forget) from the Stripe `invoice.payment_failed`
// webhook. Resolves the Stripe customer back to a resupply patient and
// dispatches the `payment_failed` alert over email, IF the
// `alerts.auto_dispatch` feature flag is on.
//
// Why this is a separate module from the webhook handler:
//   * The webhook handler must ACK Stripe in milliseconds; a SendGrid
//     round-trip cannot sit on its critical path. The caller invokes
//     this WITHOUT awaiting (fire-and-forget), so the alert send runs
//     after the 200 is already on the wire.
//   * It keeps the identity-resolution chain (Stripe customer →
//     shop_customers → patients) testable in isolation.
//
// Identity chain (Stripe events carry no patient identity):
//   invoice.customer (Stripe customer id)
//     → shop_customers.stripe_customer_id → shop_customers.email_lower
//     → patients.email  (case-insensitive)  → patients.id
//
// Fail-closed: the feature flag defaults OFF, and every step that
// can't resolve simply logs + returns. A patient is never messaged
// unless the whole chain succeeds AND the flag is on.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../feature-flags";
import { dispatchAlert } from "./dispatch";

export interface PaymentFailedTriggerInput {
  /** Stripe customer id from the invoice (string form). */
  stripeCustomerId: string | null;
  /** Amount due in the smallest currency unit (cents). */
  amountDueCents: number | null;
  currency: string | null;
  /** Optional structured logger (req.log child). */
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  } | null;
}

/** PostgREST `ilike` pattern escaping — mirror of
 *  shop-orders-sms-resolver.ts so a `%`/`_` in an email is matched
 *  literally rather than as a wildcard. */
function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function formatAmount(cents: number | null, currency: string | null): string {
  if (cents == null) return "your balance";
  const major = (cents / 100).toFixed(2);
  const cur = (currency ?? "usd").toUpperCase();
  return cur === "USD" ? `$${major}` : `${major} ${cur}`;
}

/**
 * Resolve the patient behind a failed-payment event and send the
 * `payment_failed` alert. Never throws — every failure path logs and
 * returns. Safe to call fire-and-forget.
 *
 * Prefer the pg-boss job (worker/jobs/payment-failed-alert.ts), which
 * calls the throwing variant below so transient SendGrid/DB failures
 * get a retry budget; this wrapper remains the degraded path when the
 * worker isn't running.
 */
export async function maybeDispatchPaymentFailedAlert(
  input: PaymentFailedTriggerInput,
): Promise<void> {
  try {
    await dispatchPaymentFailedAlertOrThrow(input);
  } catch (err) {
    input.log?.warn?.(
      {
        event: "payment_failed_alert_error",
        err,
      },
      "alerts: payment_failed trigger failed (non-fatal)",
    );
  }
}

/**
 * Same resolution chain, but transient failures (Supabase error,
 * SendGrid send error) PROPAGATE so a retry-backed caller (the pg-boss
 * job) can re-attempt. Unresolvable inputs (no flag, no shop customer,
 * no patient) still return cleanly — retrying those can never succeed.
 */
export async function dispatchPaymentFailedAlertOrThrow(
  input: PaymentFailedTriggerInput,
): Promise<void> {
  const { stripeCustomerId, log } = input;
  if (!stripeCustomerId) return;

  // Fail-closed flag gate — merging this code does NOT start sending
  // until an operator turns the flag on.
  if (!(await isFeatureEnabled("alerts.auto_dispatch"))) return;

  const supabase = getSupabaseServiceRoleClient();

  // Stripe customer → shop_customers.email_lower.
  const { data: shopCustomer, error: scErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("email_lower")
    .eq("stripe_customer_id", stripeCustomerId)
    .limit(1)
    .maybeSingle();
  if (scErr) throw scErr;
  const email = shopCustomer?.email_lower;
  if (!email) {
    log?.info?.(
      { event: "payment_failed_alert_skipped", reason: "no_shop_customer" },
      "alerts: payment_failed trigger — no shop_customer for stripe customer",
    );
    return;
  }

  // Email → patients.id (case-insensitive).
  const { data: patient, error: pErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escapeIlike(email))
    .limit(1)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!patient?.id) {
    log?.info?.(
      { event: "payment_failed_alert_skipped", reason: "no_patient" },
      "alerts: payment_failed trigger — no patient matches shop_customer email",
    );
    return;
  }

  const outcome = await dispatchAlert({
    alertKey: "payment_failed",
    channel: "email",
    patientId: patient.id,
    variables: {
      amount: formatAmount(input.amountDueCents, input.currency),
      // No deep-link to a Stripe billing portal here — the patient
      // /account page already reflects past_due. Operators can wire a
      // real portal URL later; the template leaves {{update_payment_url}}
      // literal if unset, which is QA-visible.
    },
  });

  log?.info?.(
    {
      event: "payment_failed_alert_dispatched",
      outcome: outcome.status,
      patient_id: patient.id,
    },
    "alerts: payment_failed trigger — dispatch complete",
  );
}
