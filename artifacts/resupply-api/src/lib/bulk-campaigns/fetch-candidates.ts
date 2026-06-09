// Shared candidate fetcher for the bulk-campaigns audience pipeline.
//
// Both POST /admin/bulk-campaigns/draft (initial staging) and
// POST /admin/bulk-campaigns/:id/regenerate-audience call this
// helper to materialize the raw candidate set before handing it
// to resolveAudience() for opt-out + dedup filtering.

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import type {
  PatientCandidate,
  ShopCustomerCandidate,
} from "./resolve-audience";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type AudienceKind =
  | "all_active_shop_customers"
  | "all_active_patients"
  | "by_patient_payer"
  | "by_therapy_cohort"
  | "manual_list";

export interface FetchCandidatesInput {
  audienceKind: AudienceKind;
  /** For by_patient_payer this is the payer name; for by_therapy_cohort
   *  it carries the cohort key (see THERAPY_COHORT_ALERT_TYPES). */
  audiencePayer?: string | null;
  manualShopCustomerIds?: string[];
  manualPatientIds?: string[];
}

/**
 * Maps an RT therapy-cohort key to the `csr_compliance_alerts.alert_type`
 * values that define it. A patient is in the cohort when they have at least
 * one OPEN alert of a matching type. These alerts are written by the daily
 * compliance scanner from device-cloud therapy nights (low_usage =
 * sub-threshold adherence; no_response = no reply after a check-in).
 */
export const THERAPY_COHORT_ALERT_TYPES: Record<string, string[]> = {
  low_adherence: ["low_usage"],
  no_checkin_response: ["no_response"],
  at_risk: ["low_usage", "no_response"],
};

export interface FetchCandidatesResult {
  shopCandidates: ShopCustomerCandidate[];
  patientCandidates: PatientCandidate[];
}

/** PostgREST `.in` URL cap; lifted to keep candidate-id batches
 *  comfortably under 32KB. */
const BATCH = 1000;

/**
 * Fetches and materializes shop-customer and patient candidate lists from the `resupply` schema according to the specified audience.
 *
 * For the `"all_active_shop_customers"`, `"all_active_patients"`, and `"by_patient_payer"` modes the function pages through results to avoid PostgREST row limits; for `"manual_list"` it queries the provided ID lists in batches.
 *
 * @param input - Selection parameters. `input.audienceKind` determines which candidates are fetched:
 *   - `"all_active_shop_customers"`: all shop customers
 *   - `"all_active_patients"`: all patients with status `"active"`
 *   - `"by_patient_payer"`: active patients filtered by `input.audiencePayer`
 *   - `"manual_list"`: explicit lists in `input.manualShopCustomerIds` and `input.manualPatientIds`
 * @returns An object containing:
 *   - `shopCandidates`: array of shop customer candidates with `id`, `emailLower`, and `communicationPreferences`
 *   - `patientCandidates`: array of patient candidates with `id`, `email`, `status`, and `insurancePayer`
 * @throws The first Supabase error encountered when a query fails.
 */
export async function fetchAudienceCandidates(
  supabase: SupabaseClient,
  input: FetchCandidatesInput,
): Promise<FetchCandidatesResult> {
  const shopCandidates: ShopCustomerCandidate[] = [];
  const patientCandidates: PatientCandidate[] = [];

  if (input.audienceKind === "all_active_shop_customers") {
    // PAGINATED. PostgREST caps a single response at ~1000 rows; an
    // unpaginated select silently truncates there and the campaign
    // would only ever reach the first ~1000 customers (the recipient
    // list is materialized once from this fetch, never re-scanned).
    // Mirrors the keyset-paging pattern in worker/jobs/reminders.ts.
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("customer_id, email_lower, communication_preferences")
        .order("customer_id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        shopCandidates.push({
          id: r.customer_id,
          emailLower: r.email_lower,
          communicationPreferences:
            r.communication_preferences as ShopCustomerCandidate["communicationPreferences"],
        });
      }
      if (data.length < BATCH) break;
    }
  } else if (input.audienceKind === "all_active_patients") {
    // PAGINATED — see the note above; an unpaginated select would
    // silently drop every active patient past the first ~1000.
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, email, status, insurance_payer")
        .eq("status", "active")
        .order("id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        patientCandidates.push({
          id: r.id,
          email: r.email,
          status: r.status,
          insurancePayer: r.insurance_payer,
        });
      }
      if (data.length < BATCH) break;
    }
  } else if (input.audienceKind === "by_patient_payer") {
    // PAGINATED — see the note above; a popular payer can exceed the
    // ~1000-row cap and would otherwise be silently truncated.
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, email, status, insurance_payer")
        .eq("status", "active")
        .eq("insurance_payer", input.audiencePayer ?? "")
        .order("id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        patientCandidates.push({
          id: r.id,
          email: r.email,
          status: r.status,
          insurancePayer: r.insurance_payer,
        });
      }
      if (data.length < BATCH) break;
    }
  } else if (input.audienceKind === "by_therapy_cohort") {
    // Resolve the cohort to a distinct set of patient ids via the open
    // compliance-alert queue, then load those patients. The cohort key
    // arrives in `audiencePayer` (see FetchCandidatesInput).
    const alertTypes =
      THERAPY_COHORT_ALERT_TYPES[(input.audiencePayer ?? "").trim()] ?? [];
    if (alertTypes.length > 0) {
      const patientIds = new Set<string>();
      for (let from = 0; ; from += BATCH) {
        const { data, error } = await supabase
          .schema("resupply")
          .from("csr_compliance_alerts")
          .select("patient_id")
          .eq("status", "open")
          .in("alert_type", alertTypes)
          .order("patient_id", { ascending: true })
          .range(from, from + BATCH - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const r of data) {
          if (r.patient_id) patientIds.add(r.patient_id);
        }
        if (data.length < BATCH) break;
      }
      const ids = [...patientIds];
      for (let i = 0; i < ids.length; i += BATCH) {
        const slice = ids.slice(i, i + BATCH);
        const { data, error } = await supabase
          .schema("resupply")
          .from("patients")
          .select("id, email, status, insurance_payer")
          .in("id", slice);
        if (error) throw error;
        for (const r of data ?? []) {
          patientCandidates.push({
            id: r.id,
            email: r.email,
            status: r.status,
            insurancePayer: r.insurance_payer,
          });
        }
      }
    }
  } else if (input.audienceKind === "manual_list") {
    const shopIds = input.manualShopCustomerIds ?? [];
    for (let i = 0; i < shopIds.length; i += BATCH) {
      const slice = shopIds.slice(i, i + BATCH);
      const { data, error } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("customer_id, email_lower, communication_preferences")
        .in("customer_id", slice);
      if (error) throw error;
      for (const r of data ?? []) {
        shopCandidates.push({
          id: r.customer_id,
          emailLower: r.email_lower,
          communicationPreferences:
            r.communication_preferences as ShopCustomerCandidate["communicationPreferences"],
        });
      }
    }
    const patientIds = input.manualPatientIds ?? [];
    for (let i = 0; i < patientIds.length; i += BATCH) {
      const slice = patientIds.slice(i, i + BATCH);
      const { data, error } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, email, status, insurance_payer")
        .in("id", slice);
      if (error) throw error;
      for (const r of data ?? []) {
        patientCandidates.push({
          id: r.id,
          email: r.email,
          status: r.status,
          insurancePayer: r.insurance_payer,
        });
      }
    }
  }

  return { shopCandidates, patientCandidates };
}
