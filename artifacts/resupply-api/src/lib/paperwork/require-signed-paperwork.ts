// Paperwork sign-off gate — the verification stop that blocks an order
// from being marked shipped (or picked up) until the patient has signed
// the required intake paperwork.
//
// Two independent triggers make paperwork required (migration 0248):
//   * GLOBAL  — the `orders.require_signed_paperwork` feature flag
//     (default OFF). When ON, every patient-linked order is gated.
//   * PER-PAYER — `payer_profiles.requires_signed_paperwork`. When the
//     patient's primary insurance coverage maps to a payer profile with
//     this flag set, the patient's orders are gated even with the
//     global flag OFF.
//
// "Required paperwork" is the same set the dispense-readiness reviewer
// treats as required-before-dispense: HIPAA Notice of Privacy Practices,
// Assignment of Benefits, and Supplier Standards. Signatures are read
// from `patient_form_acknowledgements` (any form_version counts), the
// canonical click-through / paper-scan e-sign store.
//
// Scope: the gate only applies to orders that resolve to a clinical
// patient (shop_orders.customer_id → shop_customers.auth_user_id →
// patients.portal_auth_user_id). A guest / cash-pay storefront order
// with no patient record has no paperwork to sign, so the gate is a
// no-op for it — turning on the global flag must never brick accessory
// sales.
//
// PHI posture: this module returns booleans + generic form labels. It
// never logs or returns patient identifiers beyond the resolved
// patient id (a UUID the caller already holds), and the caller logs
// counts only.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../feature-flags";

/** Why a paperwork requirement applies to an order. */
export type PaperworkRequirementSource = "global" | "payer";

/** The fixed set of intake forms that must be signed before shipment.
 *
 * Mirrors the required-acknowledgement set in
 * lib/billing/dispense-readiness-reviewer.ts so the ship gate and the
 * pre-dispense reviewer never disagree about what "paperwork on file"
 * means. `kind` matches the `patient_form_acknowledgements.form_kind`
 * enum (migration 0106). */
export const REQUIRED_PAPERWORK_FORMS = [
  { kind: "hipaa_npp", label: "HIPAA Notice of Privacy Practices" },
  { kind: "aob", label: "Assignment of Benefits" },
  { kind: "supplier_standards", label: "Supplier Standards" },
] as const;

export type RequiredPaperworkFormKind =
  (typeof REQUIRED_PAPERWORK_FORMS)[number]["kind"];

export interface RequiredFormStatus {
  kind: RequiredPaperworkFormKind;
  label: string;
  signed: boolean;
}

export interface PaperworkGateDecision {
  /** True when a signed-paperwork requirement applies to this order. */
  required: boolean;
  /** True when the requirement is satisfied — or no requirement applies. */
  satisfied: boolean;
  /** Why the requirement applies. Empty when `required` is false. */
  sources: PaperworkRequirementSource[];
  /** The clinical patient this order resolved to, or null for a guest. */
  patientId: string | null;
  /** Per-form sign-off status. Empty when no requirement applies. */
  forms: RequiredFormStatus[];
  /** Labels of the required forms still missing a signature. */
  missingForms: string[];
}

const NOT_REQUIRED: PaperworkGateDecision = {
  required: false,
  satisfied: true,
  sources: [],
  patientId: null,
  forms: [],
  missingForms: [],
};

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/**
 * Resolve the clinical patient behind a shop order's customer, if any.
 * Returns null for guest / non-clinical customers (no auth user, or an
 * auth user with no patient record).
 */
async function resolvePatientIdForCustomer(
  supabase: SupabaseClient,
  customerId: string,
): Promise<string | null> {
  const { data: customer, error: custErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("auth_user_id")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!customer?.auth_user_id) return null;

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("portal_auth_user_id", customer.auth_user_id)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  return patient?.id ?? null;
}

/**
 * True when the patient's primary insurance coverage maps to a payer
 * profile that requires signed paperwork. Mirrors the reviewer's
 * coverage→profile resolution (case-insensitive display_name match on
 * the primary coverage). An unmatched / absent payer imposes no
 * payer-level requirement (the global flag may still apply).
 */
async function payerRequiresPaperwork(
  supabase: SupabaseClient,
  patientId: string,
): Promise<boolean> {
  const { data: coverage, error: covErr } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select("payer_name")
    .eq("patient_id", patientId)
    .eq("rank", "primary")
    .limit(1)
    .maybeSingle();
  if (covErr) throw covErr;
  if (!coverage?.payer_name) return false;

  const { data: payer, error: payerErr } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("requires_signed_paperwork")
    .eq("is_active", true)
    .ilike("display_name", coverage.payer_name)
    .limit(1)
    .maybeSingle();
  if (payerErr) throw payerErr;
  return payer?.requires_signed_paperwork === true;
}

/**
 * Which of the required forms the patient has on file. Reads
 * `patient_form_acknowledgements`; any `form_version` of a `form_kind`
 * counts as signed.
 */
async function loadRequiredFormStatuses(
  supabase: SupabaseClient,
  patientId: string,
): Promise<RequiredFormStatus[]> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_form_acknowledgements")
    .select("form_kind")
    .eq("patient_id", patientId);
  if (error) throw error;
  const signed = new Set<string>((data ?? []).map((r) => r.form_kind));
  return REQUIRED_PAPERWORK_FORMS.map((f) => ({
    kind: f.kind,
    label: f.label,
    signed: signed.has(f.kind),
  }));
}

/**
 * Evaluate the paperwork sign-off gate for a shop order, given the
 * order's customer id (the caller has already loaded the order, so we
 * don't re-query shop_orders here).
 *
 * Returns `{ required, satisfied, ... }`. The caller blocks the ship
 * transition when `required && !satisfied`.
 */
export async function evaluatePaperworkGateForCustomer(
  customerId: string | null,
): Promise<PaperworkGateDecision> {
  // Guest / non-clinical order — nothing to sign, never gated.
  if (!customerId) return NOT_REQUIRED;

  const supabase = getSupabaseServiceRoleClient();
  const patientId = await resolvePatientIdForCustomer(supabase, customerId);
  if (!patientId) return NOT_REQUIRED;

  // Determine whether a requirement applies (global flag and/or payer).
  const sources: PaperworkRequirementSource[] = [];
  if (await isFeatureEnabled("orders.require_signed_paperwork")) {
    sources.push("global");
  }
  if (await payerRequiresPaperwork(supabase, patientId)) {
    sources.push("payer");
  }
  if (sources.length === 0) {
    return { ...NOT_REQUIRED, patientId };
  }

  const forms = await loadRequiredFormStatuses(supabase, patientId);
  const missingForms = forms.filter((f) => !f.signed).map((f) => f.label);
  return {
    required: true,
    satisfied: missingForms.length === 0,
    sources,
    patientId,
    forms,
    missingForms,
  };
}
