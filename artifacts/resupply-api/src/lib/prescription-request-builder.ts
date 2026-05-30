// Build the inputs for a prescription_request_packets row from an
// existing prescription + the patient's clinical context.
//
// Shared between:
//   * The one-click renewal route
//     (POST /admin/patients/:id/prescription-requests/from-prescription/:rxId)
//   * The auto-draft worker
//     (worker/jobs/prescription-request-auto-draft.ts)
//
// Both call sites need the same rules so the packet a CSR creates
// by hand looks identical to the one the worker minted overnight.
//
// PHI posture: returns plain JS values. Logger never sees clinical
// content; callers log only Rx ids + outcome tags.

import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type BuildPacketOutcome =
  | { kind: "ok"; insert: PacketInsert }
  | { kind: "rx_not_found" }
  | { kind: "rx_missing_provider" }
  | { kind: "rx_missing_hcpcs" };

export type PacketInsert =
  Database["resupply"]["Tables"]["prescription_request_packets"]["Insert"];

export interface BuildPacketInput {
  patientId: string;
  prescriptionId: string;
  /**
   * Email written into created_by_email — pass the admin's email
   * for hand-renewal, the cron actor identifier for the worker.
   */
  createdByEmail: string;
}

/**
 * Resolve the prescription + the patient's latest sleep study,
 * project them into a PacketInsert, and return either an "ok" or
 * a tagged-union failure the caller can surface verbatim.
 *
 * Does NOT execute the insert — the caller decides whether to
 * write directly (worker), refuse with 4xx (route), or wrap in
 * its own audit (both).
 */
export async function buildPrescriptionRequestPacketFromRx(
  input: BuildPacketInput,
): Promise<BuildPacketOutcome> {
  const supabase: SupabaseClient = getSupabaseServiceRoleClient();
  const { data: rx } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select(
      "id, patient_id, provider_id, hcpcs_code, item_sku, cadence_days, valid_until",
    )
    .eq("id", input.prescriptionId)
    .eq("patient_id", input.patientId)
    .limit(1)
    .maybeSingle();
  if (!rx) return { kind: "rx_not_found" };
  if (!rx.provider_id) return { kind: "rx_missing_provider" };
  if (!rx.hcpcs_code) return { kind: "rx_missing_hcpcs" };

  const { data: study } = await supabase
    .schema("resupply")
    .from("sleep_studies")
    .select("diagnosis_icd10")
    .eq("patient_id", input.patientId)
    .order("study_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  // Normalise to upper case BEFORE validating — sleep_studies rows
  // come from CSR input + EHR snapshots and can ship lowercase
  // ("g47.30") even when the format is otherwise valid.
  const rawIcd = study?.diagnosis_icd10?.toUpperCase() ?? null;
  const icd10 =
    rawIcd && /^[A-Z]\d{2}(\.\d{1,4})?$/.test(rawIcd) ? [rawIcd] : ["G47.33"];

  const { data: provider } = await supabase
    .schema("resupply")
    .from("providers")
    .select("id, fax_e164")
    .eq("id", rx.provider_id)
    .limit(1)
    .maybeSingle();

  const hcpcsLines = [
    {
      hcpcs: rx.hcpcs_code,
      description: rx.item_sku,
      quantity: 1,
      cadenceDays: rx.cadence_days > 0 ? rx.cadence_days : null,
    },
  ];

  const insert: PacketInsert = {
    patient_id: input.patientId,
    provider_id: rx.provider_id,
    source_prescription_id: rx.id,
    hcpcs_items_json: hcpcsLines as unknown as Json,
    icd10_codes_json: icd10 as unknown as Json,
    device_settings_json: null,
    length_of_need_months: 99,
    return_fax_e164: provider?.fax_e164 ?? null,
    return_email: null,
    clinical_notes: null,
    status: "draft",
    created_by_email: input.createdByEmail,
  };
  return { kind: "ok", insert };
}
