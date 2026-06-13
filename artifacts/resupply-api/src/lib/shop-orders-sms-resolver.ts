// Resolve the SMS-eligible recipient for a shop_orders-side
// notification (shipped / delivered).
//
// Why this lives in a shared lib
// ------------------------------
// Two callers need the same logic: the shipping-notification path
// (admin tracking-entry endpoint) and the post-delivery follow-up
// worker. Both want to know:
//
//   1. Does this order's customer have a verified phone number we
//      can text? Today the shop_customers row has no phone column;
//      the canonical source is resupply.patients.phone_e164 when the
//      patient is also a DME-registered patient.
//   2. Has the patient opted IN to transactional SMS via
//      communication_preferences.smsTransactional?
//
// Both gates pass before we return the phone. A nullable return
// means "no SMS — skip silently."
//
// Privacy
// -------
// The function never logs the phone number. Callers should log
// counts only.

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { shouldSendSms } from "./comm-prefs";

function readPrefs(raw: Json | null): CommunicationPreferences {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_COMMUNICATION_PREFERENCES;
  }
  return {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...(raw as Partial<CommunicationPreferences>),
  };
}

export interface ResolveSmsRecipientArgs {
  customerId: string | null;
  customerEmailFromOrder: string | null;
}

export interface SmsRecipient {
  phoneE164: string;
  patientFirstName: string | null;
  /** Patient's IANA timezone, for the TCPA send-window gate. */
  timezone: string | null;
  /** Patient's address ZIP — timezone inference fallback. */
  zip: string | null;
}

/**
 * Return phone + first-name when ALL of:
 *   * shop_customers has a comm-prefs row with smsTransactional=true,
 *   * resupply.patients has a row whose email matches (case-insensitive),
 *   * that patient row has a non-null phone_e164.
 * Otherwise null.
 */
export async function resolveSmsRecipientForShopOrder(
  args: ResolveSmsRecipientArgs,
): Promise<SmsRecipient | null> {
  const supabase = getSupabaseServiceRoleClient();

  // 1. Pull the shop_customer's email + comm-prefs.
  let email: string | null = null;
  let prefs: CommunicationPreferences = DEFAULT_COMMUNICATION_PREFERENCES;
  if (args.customerId) {
    const { data: cust } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("email_lower, communication_preferences")
      .eq("customer_id", args.customerId)
      .limit(1)
      .maybeSingle();
    if (cust?.email_lower) {
      email = cust.email_lower;
      prefs = readPrefs(cust.communication_preferences ?? null);
    }
  }
  if (!email && args.customerEmailFromOrder) {
    email = args.customerEmailFromOrder;
    // Without a shop_customers row we use the default prefs, which
    // sets smsTransactional=false — gating returns null below.
  }
  if (!email) return null;
  if (!shouldSendSms(prefs, "transactional")) return null;

  // 2. Walk to a matching patients row (case-insensitive email).
  //    DME-registered patients are the cohort where SMS adds real
  //    value (repeat shipments); cash-pay-only shoppers without a
  //    patients row fall through to email-only.
  // Escape LIKE metacharacters so an email containing `_` or
  // `%` doesn't cross-match other patients' phone numbers.
  const escapedEmail = email.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: patients } = await supabase
    .schema("resupply")
    .from("patients")
    .select("phone_e164, legal_first_name, timezone, address")
    .ilike("email", escapedEmail)
    .limit(2);
  if (!patients || patients.length !== 1) return null;
  const patient = patients[0]!;
  if (!patient?.phone_e164) return null;

  const address = patient.address as { zip?: string } | null;
  return {
    phoneE164: patient.phone_e164,
    patientFirstName: patient.legal_first_name ?? null,
    timezone: patient.timezone ?? null,
    zip: address?.zip ?? null,
  };
}
