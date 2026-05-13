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
  | "manual_list";

export interface FetchCandidatesInput {
  audienceKind: AudienceKind;
  audiencePayer?: string | null;
  manualShopCustomerIds?: string[];
  manualPatientIds?: string[];
}

export interface FetchCandidatesResult {
  shopCandidates: ShopCustomerCandidate[];
  patientCandidates: PatientCandidate[];
}

/** PostgREST `.in` URL cap; lifted to keep candidate-id batches
 *  comfortably under 32KB. */
const BATCH = 1000;

export async function fetchAudienceCandidates(
  supabase: SupabaseClient,
  input: FetchCandidatesInput,
): Promise<FetchCandidatesResult> {
  const shopCandidates: ShopCustomerCandidate[] = [];
  const patientCandidates: PatientCandidate[] = [];

  if (input.audienceKind === "all_active_shop_customers") {
    const { data, error } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("customer_id, email_lower, communication_preferences");
    if (error) throw error;
    for (const r of data ?? []) {
      shopCandidates.push({
        id: r.customer_id,
        emailLower: r.email_lower,
        communicationPreferences:
          r.communication_preferences as ShopCustomerCandidate["communicationPreferences"],
      });
    }
  } else if (input.audienceKind === "all_active_patients") {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, email, status, insurance_payer")
      .eq("status", "active");
    if (error) throw error;
    for (const r of data ?? []) {
      patientCandidates.push({
        id: r.id,
        email: r.email,
        status: r.status,
        insurancePayer: r.insurance_payer,
      });
    }
  } else if (input.audienceKind === "by_patient_payer") {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, email, status, insurance_payer")
      .eq("status", "active")
      .eq("insurance_payer", input.audiencePayer ?? "");
    if (error) throw error;
    for (const r of data ?? []) {
      patientCandidates.push({
        id: r.id,
        email: r.email,
        status: r.status,
        insurancePayer: r.insurance_payer,
      });
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
