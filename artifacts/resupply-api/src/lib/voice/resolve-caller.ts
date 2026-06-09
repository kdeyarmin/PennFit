// Resolve an inbound caller's phone number to a known account.
//
// Used by the inbound voice reorder IVR (and reusable by any caller-ID
// driven flow). Resolution is UNIFIED across the two customer models:
//   1. Clinical patients (resupply.patients.phone_e164) — checked FIRST.
//   2. Cash-pay storefront customers (resupply.shop_customers.phone_e164).
// Patients win on a tie: a person who is both a clinical patient and a
// storefront customer resolves as a patient so the existing DOB-gated
// reorder flow applies.
//
// Ambiguity (one phone shared by more than one account of the same kind,
// e.g. a household/family plan) is reported as `ambiguous` rather than
// guessing — the caller is then routed to a human where identity can be
// verified out of band. This mirrors the inbound SMS handler's
// shared-number rule.
//
// PHI posture: the phone number is PHI. This module logs nothing; callers
// decide what (if anything) to record, and the existing callers log only
// digit-counts.
//
// Error posture: a lookup query that ERRORS is thrown, not swallowed.
// Treating a DB failure as "no match" would silently mis-route the caller
// (and hide the outage); the caller is responsible for handling the throw
// (the inbound IVR returns a "please try again" hangup, matching how it
// already treats a session-insert DB failure). Mirrors the voice tool
// dispatcher, which also throws on Supabase read errors.

import { type ResupplySupabaseClient } from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";

export type CallerResolution =
  | { kind: "patient"; patientId: string }
  | { kind: "shop_customer"; customerId: string }
  | { kind: "ambiguous" }
  | { kind: "none" };

export async function resolveCallerByPhone(
  supabase: ResupplySupabaseClient,
  fromE164: string,
): Promise<CallerResolution> {
  if (!fromE164) return { kind: "none" };
  // Canonical E.164 normalisation — a bare 10-digit US caller ID maps to
  // +1XXXXXXXXXX so it matches the stored *.phone_e164 columns. null ⇒
  // unparseable ⇒ unidentified (and we don't touch the DB).
  const normalised = normalizeE164(fromE164);
  if (!normalised) return { kind: "none" };

  // 1. Clinical patients first. Pull up to 2 rows to detect a shared
  //    number: multiple patients on one phone (a family/household plan)
  //    can't be safely auto-bound to a patient-scoped agent, so we treat
  //    it as ambiguous and let the caller route to a human.
  const { data: patientRows, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("phone_e164", normalised)
    .limit(2);
  if (patientErr) throw patientErr;
  const patients = patientRows ?? [];
  if (patients.length > 1) return { kind: "ambiguous" };
  const patient = patients[0];
  if (patient) return { kind: "patient", patientId: patient.id };

  // 2. Only if no patient matched, try the cash-pay storefront. Same
  //    shared-number guard.
  const { data: shopRows, error: shopErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id")
    .eq("phone_e164", normalised)
    .limit(2);
  if (shopErr) throw shopErr;
  const shopCustomers = shopRows ?? [];
  if (shopCustomers.length > 1) return { kind: "ambiguous" };
  const shopCustomer = shopCustomers[0];
  if (shopCustomer) {
    return { kind: "shop_customer", customerId: shopCustomer.customer_id };
  }

  return { kind: "none" };
}
