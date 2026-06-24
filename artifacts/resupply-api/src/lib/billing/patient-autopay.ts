// Patient card-on-file + autopay service (patient-controlled).
//
// SAFETY CONTRACT — read before touching:
//   * This is the patient-initiated cousin of the CSR-driven payment-plan
//     autopay (lib/billing/payment-plan-autocharge.ts). Same off-session
//     mandate model: a card is only ever charged when the patient
//     completed a Stripe *setup* Checkout (capturing Stripe's standard
//     recurring-charge consent) AND explicitly toggled autopay ON.
//   * Saving a card NEVER charges anything and NEVER enables autopay on
//     its own — `autopay_enabled` is a separate, default-FALSE switch the
//     patient controls.
//   * The actual money movement lives in the worker
//     (worker/jobs/patient-autopay-charge.ts), gated by the seeded-OFF
//     billing.patient_autopay flag + an env cron. This module only
//     captures consent, exposes status, and provides the PURE selector
//     the worker uses.
//
// One ACTIVE (revoked_at IS NULL) authorization per patient, enforced by
// a partial unique index (migration 0260). Adding a card updates the
// active row in place; removing it stamps revoked_at.

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";
import type Stripe from "stripe";

import { logger } from "../logger";
import {
  getStripeClient,
  readStripeConfigOrNull,
  type StripeConfig,
} from "../stripe/config";
import { stripeAccountRequestOptions } from "../stripe/connect";
import { resolveWebhookOrgId } from "../stripe/webhook-org-context";

const PURPOSE = "patient_autopay_setup" as const;

/** Max automatic attempts before we stop and leave it for a human. */
export const MAX_AUTOPAY_CHARGE_ATTEMPTS = 4;

type AutopayRow =
  Database["resupply"]["Tables"]["patient_autopay_authorizations"]["Row"];

/** Client-facing shape — never exposes the Stripe ids. */
export interface AutopayCardView {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface AutopayStatusView {
  hasCard: boolean;
  autopayEnabled: boolean;
  card: AutopayCardView | null;
  authorizedAt: string | null;
}

export function toAutopayStatusView(row: AutopayRow | null): AutopayStatusView {
  if (!row) {
    return {
      hasCard: false,
      autopayEnabled: false,
      card: null,
      authorizedAt: null,
    };
  }
  return {
    hasCard: true,
    autopayEnabled: row.autopay_enabled,
    authorizedAt: row.authorized_at,
    card: {
      brand: row.card_brand,
      last4: row.card_last4,
      expMonth: row.card_exp_month,
      expYear: row.card_exp_year,
    },
  };
}

// ─── Setup session (add a card) ──────────────────────────────────────────

export interface CreateAutopaySetupSessionInput {
  patientId: string;
  /** The shop_customers.customer_id that initiated this. */
  shopCustomerId: string;
  /** A Stripe Customer the PM attaches to (mint via getOrCreateStripeCustomer). */
  stripeCustomerId: string;
  /**
   * Tenant the setup runs for (the caller's req.orgId). The session is
   * created ON this tenant's connected account (G5) so the saved card +
   * customer live on the SAME account the autocharge worker later debits —
   * a saved PaymentMethod is account-scoped. Undefined / not-onboarded →
   * the platform account, unchanged.
   */
  orgId: string | undefined;
  successUrl: string;
  cancelUrl: string;
  /** Whether to flip autopay ON the moment the card is saved. */
  enableAutopay: boolean;
  /** Stamped into metadata for the "who authorized this" audit trail. */
  initiatorEmail: string | null;
}

export type CreateAutopaySetupSessionResult =
  | { url: string }
  | { error: "stripe_not_configured" | "stripe_error" | "stripe_no_url" };

/**
 * Create a Stripe Checkout *setup* session so the patient can save a card
 * on file. Stripe's hosted page captures the off-session mandate consent.
 * The completion is processed by the webhook (recordAutopayAuthorization)
 * keyed on metadata.purpose — no DB row is created here.
 */
export async function createAutopaySetupSession(
  input: CreateAutopaySetupSessionInput,
): Promise<CreateAutopaySetupSessionResult> {
  const config = readStripeConfigOrNull();
  if (!config) return { error: "stripe_not_configured" };
  const metadata: Record<string, string> = {
    patient_id: input.patientId,
    shop_customer_id: input.shopCustomerId,
    purpose: PURPOSE,
    enable_autopay: input.enableAutopay ? "1" : "0",
  };
  if (input.initiatorEmail) metadata.initiator_email = input.initiatorEmail;

  let session: Stripe.Checkout.Session;
  try {
    const stripe = getStripeClient(config);
    // Route the setup session to the tenant's connected account (G5) so the
    // saved card + customer live on the SAME account the autopay-charge
    // worker debits (a SetupIntent's PaymentMethod is account-scoped). The
    // worker (worker/jobs/patient-autopay-charge.ts) and the webhook that
    // stores the PM (recordAutopayAuthorization, below) route to the same
    // account. Empty for the platform account (seed / not-onboarded),
    // unchanged.
    const accountOptions = await stripeAccountRequestOptions(input.orgId);
    session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        payment_method_types: ["card"],
        customer: input.stripeCustomerId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata,
        setup_intent_data: {
          metadata: { patient_id: input.patientId, purpose: PURPOSE },
        },
      },
      accountOptions,
    );
  } catch (err) {
    // Log the Error object so pino's serializer redacts message/stack.
    logger.warn({ err }, "patient-autopay: setup session create failed");
    return { error: "stripe_error" };
  }
  if (!session.url) return { error: "stripe_no_url" };
  return { url: session.url };
}

// ─── Webhook: record the saved card ──────────────────────────────────────

/**
 * Complete a patient autopay setup (mode=setup Checkout). Reads the
 * payment method off the SetupIntent, pulls the card crumbs, and upserts
 * the patient's single active authorization. Idempotent — re-delivery
 * re-writes the same values. NEVER enables autopay unless the patient
 * asked for it at add-card time (metadata.enable_autopay).
 */
export async function recordAutopayAuthorization(
  config: StripeConfig,
  session: Stripe.Checkout.Session,
  log?: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const patientId = session.metadata?.patient_id;
  if (!patientId) return;
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer?.id ?? null);

  // Resolve the webhook's tenant FIRST — for a connected-account setup the
  // SetupIntent / customer / PM live ON that account, so we must retrieve
  // them with its `{ stripeAccount }` (G5). The event carries the account
  // context (resolveWebhookOrgId → the event.account tenant). Switched from
  // resolveSeedOrgId so a non-seed tenant's autopay setup records under the
  // correct org. Empty options for the platform account, unchanged.
  const orgId = await resolveWebhookOrgId();
  if (!orgId) {
    throw new Error(
      "patient-autopay: tenant context missing (webhook org unresolved)",
    );
  }
  const accountOptions = await stripeAccountRequestOptions(orgId);

  const stripe = getStripeClient(config);
  const setupIntentId =
    typeof session.setup_intent === "string"
      ? session.setup_intent
      : (session.setup_intent?.id ?? null);
  let paymentMethodId: string | null = null;
  if (setupIntentId) {
    const si = await stripe.setupIntents.retrieve(
      setupIntentId,
      undefined,
      accountOptions,
    );
    paymentMethodId =
      typeof si.payment_method === "string"
        ? si.payment_method
        : (si.payment_method?.id ?? null);
  }
  if (!stripeCustomerId || !paymentMethodId) {
    log?.info?.(
      {
        patientId,
        hasCustomer: Boolean(stripeCustomerId),
        hasPm: Boolean(paymentMethodId),
      },
      "stripe webhook: patient autopay setup completed but customer/PM missing — not recording",
    );
    return;
  }

  // Pull card crumbs for portal display (never the PAN).
  let card: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } = {
    brand: null,
    last4: null,
    expMonth: null,
    expYear: null,
  };
  try {
    const pm = await stripe.paymentMethods.retrieve(
      paymentMethodId,
      undefined,
      accountOptions,
    );
    if (pm.card) {
      card = {
        brand: pm.card.brand ?? null,
        last4: pm.card.last4 ?? null,
        expMonth: pm.card.exp_month ?? null,
        expYear: pm.card.exp_year ?? null,
      };
    }
  } catch (err) {
    // Card crumbs are cosmetic — the PM id is what matters for charging.
    log?.info?.(
      { err, patientId },
      "stripe webhook: card crumb fetch failed (non-fatal)",
    );
  }

  const wantsAutopay = session.metadata?.enable_autopay === "1";
  const shopCustomerId = session.metadata?.shop_customer_id ?? null;
  const initiatorEmail = session.metadata?.initiator_email ?? null;
  // orgId resolved above (resolveWebhookOrgId) — the same tenant the
  // SetupIntent/PM were retrieved from.
  const supabase = getOrgScopedClient(orgId);
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from("patient_autopay_authorizations")
    .select("id, autopay_enabled")
    .eq("patient_id", patientId)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Swap the card on the existing active authorization. Fresh card =>
    // fresh attempt budget. Only flip autopay ON (never off) here.
    const enableNow = wantsAutopay && !existing.autopay_enabled;
    const { error } = await supabase
      .from("patient_autopay_authorizations")
      .update({
        stripe_customer_id: stripeCustomerId,
        stripe_payment_method_id: paymentMethodId,
        card_brand: card.brand,
        card_last4: card.last4,
        card_exp_month: card.expMonth,
        card_exp_year: card.expYear,
        authorized_at: now,
        charge_attempts: 0,
        last_charge_error: null,
        ...(enableNow
          ? { autopay_enabled: true, autopay_enabled_at: now }
          : {}),
        updated_at: now,
      })
      .eq("id", existing.id);
    if (error) throw error;
    log?.info?.({ patientId }, "stripe webhook: patient autopay card updated");
    return;
  }

  const { error } = await supabase
    .from("patient_autopay_authorizations")
    .insert({
      patient_id: patientId,
      shop_customer_id: shopCustomerId,
      stripe_customer_id: stripeCustomerId,
      stripe_payment_method_id: paymentMethodId,
      card_brand: card.brand,
      card_last4: card.last4,
      card_exp_month: card.expMonth,
      card_exp_year: card.expYear,
      autopay_enabled: wantsAutopay,
      authorized_at: now,
      autopay_enabled_at: wantsAutopay ? now : null,
      created_by: initiatorEmail ? `customer:${initiatorEmail}` : null,
    });
  if (error) {
    // A racing sibling insert trips the partial-unique index; re-read and
    // update instead of failing the webhook (which would 500 + retry).
    if ((error as { code?: string }).code === "23505") {
      await recordAutopayAuthorization(config, session, log);
      return;
    }
    throw error;
  }
  log?.info?.({ patientId }, "stripe webhook: patient autopay card saved");
}

// ─── Status / toggle / revoke ────────────────────────────────────────────

export async function getActiveAutopayAuthorization(
  orgId: string | undefined,
  patientId: string,
): Promise<AutopayRow | null> {
  if (!orgId) return null;
  const supabase = getOrgScopedClient(orgId);
  const { data } = await supabase
    .from("patient_autopay_authorizations")
    .select("*")
    .eq("patient_id", patientId)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  return (data ?? null) as AutopayRow | null;
}

export type SetAutopayResult =
  | { ok: true; autopayEnabled: boolean }
  | { error: "no_card_on_file" };

/** Flip the patient-controlled autopay switch. Requires a card on file. */
export async function setAutopayEnabled(
  orgId: string | undefined,
  patientId: string,
  enabled: boolean,
  actor: string | null,
): Promise<SetAutopayResult> {
  if (!orgId) return { error: "no_card_on_file" };
  const row = await getActiveAutopayAuthorization(orgId, patientId);
  if (!row) return { error: "no_card_on_file" };
  const supabase = getOrgScopedClient(orgId);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("patient_autopay_authorizations")
    .update({
      autopay_enabled: enabled,
      autopay_enabled_at: enabled ? now : row.autopay_enabled_at,
      autopay_disabled_at: enabled ? row.autopay_disabled_at : now,
      // Turning autopay back on resets the attempt budget so an old
      // decline doesn't permanently freeze a re-enabled card.
      ...(enabled ? { charge_attempts: 0, last_charge_error: null } : {}),
      created_by: actor ?? row.created_by,
      updated_at: now,
    })
    .eq("id", row.id);
  if (error) throw error;
  return { ok: true, autopayEnabled: enabled };
}

export type RevokeAutopayResult = { ok: true } | { error: "no_card_on_file" };

/**
 * Remove the saved card: stamp revoked_at (freeing the active slot) and
 * best-effort detach the PM at Stripe so it can't be charged again. The
 * payment_method.detached webhook is idempotent with this.
 */
export async function revokeAutopayAuthorization(
  orgId: string | undefined,
  patientId: string,
  actor: string | null,
): Promise<RevokeAutopayResult> {
  if (!orgId) return { error: "no_card_on_file" };
  const row = await getActiveAutopayAuthorization(orgId, patientId);
  if (!row) return { error: "no_card_on_file" };
  const config = readStripeConfigOrNull();
  if (config) {
    try {
      const stripe = getStripeClient(config);
      // The saved PM lives on the tenant's CONNECTED account (the setup
      // session + autopay-charge worker both route there via
      // stripeAccountRequestOptions). Detach must target the SAME account,
      // or Stripe 404s the PM on the platform account and the card stays
      // attached/usable on the connected account after the patient removed
      // it. Empty options for the platform account (seed / not-onboarded).
      const accountOptions = await stripeAccountRequestOptions(orgId);
      await stripe.paymentMethods.detach(
        row.stripe_payment_method_id,
        undefined,
        accountOptions,
      );
    } catch (err) {
      // Already-detached / unknown PM is fine — we still revoke locally.
      logger.info(
        { err, patientId },
        "patient-autopay: PM detach failed (non-fatal)",
      );
    }
  }
  const supabase = getOrgScopedClient(orgId);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("patient_autopay_authorizations")
    .update({
      revoked_at: now,
      autopay_enabled: false,
      autopay_disabled_at: now,
      created_by: actor ?? row.created_by,
      updated_at: now,
    })
    .eq("id", row.id);
  if (error) throw error;
  return { ok: true };
}

/**
 * Webhook hook: a patient removed the card via Stripe's own Customer
 * Portal (payment_method.detached). Revoke any active authorization that
 * points at the detached PM so we never try to charge a dead card.
 */
export async function clearAutopayByPaymentMethod(
  paymentMethodId: string,
  log?: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  // Webhook (payment_method.detached) → resolve the event's tenant, not the
  // seed org, so a non-seed tenant's detached card is revoked under the
  // correct org (matching where the autopay authorization was written).
  const orgId = await resolveWebhookOrgId();
  if (!orgId) return;
  const supabase = getOrgScopedClient(orgId);
  const now = new Date().toISOString();
  const { error, data } = await supabase
    .from("patient_autopay_authorizations")
    .update({
      revoked_at: now,
      autopay_enabled: false,
      autopay_disabled_at: now,
      updated_at: now,
    })
    .eq("stripe_payment_method_id", paymentMethodId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw error;
  if (data && data.length > 0) {
    log?.info?.(
      { paymentMethodId, count: data.length },
      "stripe webhook: revoked patient autopay on PM detach",
    );
  }
}

// ─── Pure selector for the worker ────────────────────────────────────────

export interface ChargeableAuthorization {
  id: string;
  patientId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  autopayEnabled: boolean;
  chargeAttempts: number;
  /** ISO timestamp of the last charge attempt, or null. */
  lastChargeAttemptAt: string | null;
}

/**
 * Pure: given the active authorizations and "today" (YYYY-MM-DD), return
 * the ones eligible for an auto-charge attempt right now.
 *
 * Eligible iff ALL hold:
 *   * autopay is enabled and a stored customer + PM are present,
 *   * the attempt budget isn't exhausted (chargeAttempts < max),
 *   * we haven't already attempted today (at most one attempt/patient/day,
 *     so a declining card isn't hammered and a same-day balance change
 *     doesn't double-charge).
 *
 * Whether there's actually a balance to charge is decided by the worker
 * (it needs a DB read); this selector is the cheap pre-filter.
 */
export function selectChargeableAuthorizations(
  rows: ChargeableAuthorization[],
  todayIso: string,
  maxAttempts: number = MAX_AUTOPAY_CHARGE_ATTEMPTS,
): ChargeableAuthorization[] {
  return rows.filter((r) => {
    if (!r.autopayEnabled) return false;
    if (!r.stripeCustomerId || !r.stripePaymentMethodId) return false;
    if (r.chargeAttempts >= maxAttempts) return false;
    if (
      r.lastChargeAttemptAt &&
      r.lastChargeAttemptAt.slice(0, 10) >= todayIso
    ) {
      return false;
    }
    return true;
  });
}
