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
  getOrgScopedClient,
} from "@workspace/resupply-db";

import { parseRecordedIcd10 } from "./billing/coverage-diagnosis";

type SupabaseClient = ReturnType<typeof getOrgScopedClient>;

export type BuildPacketOutcome =
  | { kind: "ok"; insert: PacketInsert }
  | { kind: "rx_not_found" }
  | { kind: "rx_missing_provider" }
  | { kind: "rx_missing_hcpcs" }
  | { kind: "rx_missing_diagnosis" }
  /** The sleep-study lookup itself failed. Distinct from "no diagnosis on
   *  file" so a transient outage is counted as an error to retry, not as a
   *  patient whose chart needs paperwork. */
  | { kind: "rx_diagnosis_lookup_failed" };

export type PacketInsert =
  Database["resupply"]["Tables"]["prescription_request_packets"]["Insert"];

export interface BuildPacketInput {
  /**
   * Tenant the prescription belongs to. The builder scopes every
   * lookup to this org — passing the caller's tenant (the worker's
   * per-org loop, the admin's req.orgId) instead of the seed org is
   * what keeps a non-seed tenant from silently reading the seed
   * tenant's prescriptions (and always 404ing).
   */
  orgId: string;
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
  const orgId = input.orgId;
  if (!orgId) return { kind: "rx_not_found" };
  const supabase: SupabaseClient = getOrgScopedClient(orgId);
  const { data: rx } = await supabase
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

  // `.not(... is null)` before ordering, matching the claim builder
  // (office-ally-batch.ts). Without it, a newer study row that records no
  // diagnosis — a titration study, or a partial EHR import — hides an older
  // study that does have one, and the packet is refused as
  // `rx_missing_diagnosis` even though a diagnosis IS on file. Under the old
  // `?? "G47.33"` default that misread was invisible; now it would stall the
  // auto-draft worker on that patient every night.
  const { data: study, error: studyErr } = await supabase
    .from("sleep_studies")
    .select("diagnosis_icd10")
    .eq("patient_id", input.patientId)
    .not("diagnosis_icd10", "is", null)
    .order("study_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A failed lookup is not an absent diagnosis. Collapsing the two would file
  // a database outage under "N patients need a sleep study attached" and send
  // someone to fix a chart that is already correct.
  if (studyErr) return { kind: "rx_diagnosis_lookup_failed" };
  // Shared validator — see parseRecordedIcd10. It handles the lowercase that
  // CSR input and EHR snapshots ship ("g47.30"), the alphanumeric extension
  // real codes carry ("S06.0X0A"), and the undotted spelling ("G4733"). The
  // local regex this replaced accepted only digits after the dot and only the
  // dotted form, so it refused legitimate diagnoses.
  const rawIcd = parseRecordedIcd10(study?.diagnosis_icd10);
  // No usable diagnosis on file → refuse to build the packet.
  //
  // This used to fall back to ["G47.33"] (obstructive sleep apnea). That is
  // the right answer for most CPAP patients, which is exactly what made it
  // dangerous: this packet is FAXED TO A PRESCRIBER TO SIGN, so an assumed
  // diagnosis becomes attested clinical documentation — and that document is
  // then what justifies billing. A prescriber skimming a pre-filled form is
  // unlikely to catch a code nobody sourced from the chart.
  //
  // Same rule the 837P builder now applies (office-ally-batch.ts): a
  // diagnosis is either in the record or the paperwork doesn't go out.
  if (!rawIcd) {
    return { kind: "rx_missing_diagnosis" };
  }
  const icd10 = [rawIcd];

  // `providers` is a GLOBAL (non-org-scoped) table — use the unscoped
  // client via `.raw()`.
  const { data: provider } = await supabase
    .raw()
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
