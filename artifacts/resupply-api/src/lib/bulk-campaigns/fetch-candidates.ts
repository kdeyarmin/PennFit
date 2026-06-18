// Shared candidate fetcher for the bulk-campaigns audience pipeline.
//
// Both POST /admin/bulk-campaigns/draft (initial staging) and
// POST /admin/bulk-campaigns/:id/regenerate-audience call this
// helper to materialize the raw candidate set before handing it
// to resolveAudience() for opt-out + dedup filtering.

import type { OrgScopedClient } from "@workspace/resupply-db";

import type {
  PatientCandidate,
  ShopCustomerCandidate,
} from "./resolve-audience";
import {
  segmentHasEquipmentCriteria,
  type PatientSegmentFilter,
} from "./patient-segment";

export type AudienceKind =
  | "all_active_shop_customers"
  | "all_active_patients"
  | "by_patient_payer"
  | "by_therapy_cohort"
  | "patient_segment"
  | "manual_list";

export interface FetchCandidatesInput {
  audienceKind: AudienceKind;
  /** For by_patient_payer this is the payer name; for by_therapy_cohort
   *  it carries the cohort key (see THERAPY_COHORT_ALERT_TYPES). */
  audiencePayer?: string | null;
  /** The composable segment spec — required when audienceKind is
   *  'patient_segment', ignored otherwise. */
  patientSegment?: PatientSegmentFilter | null;
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

/** Columns the patient candidate projection needs across every patient
 *  audience. Includes phone for the SMS channel. */
const PATIENT_CANDIDATE_COLUMNS =
  "id, email, phone_e164, status, insurance_payer";

type PatientRow = {
  id: string;
  email: string | null;
  phone_e164: string | null;
  status: string;
  insurance_payer: string | null;
};

function toPatientCandidate(r: PatientRow): PatientCandidate {
  return {
    id: r.id,
    email: r.email,
    phone: r.phone_e164,
    status: r.status,
    insurancePayer: r.insurance_payer,
  };
}

/** Escape LIKE/ILIKE metacharacters so a user-supplied substring is
 *  matched literally (PostgreSQL's default escape char is backslash). */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Fetches and materializes shop-customer and patient candidate lists from the `resupply` schema according to the specified audience.
 *
 * For the paginated modes the function pages through results to avoid PostgREST row limits; for `"manual_list"` it queries the provided ID lists in batches.
 *
 * @returns shopCandidates + patientCandidates for the requested audience.
 * @throws The first Supabase error encountered when a query fails.
 */
export async function fetchAudienceCandidates(
  supabase: OrgScopedClient,
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
        .from("shop_customers")
        .select(
          "customer_id, email_lower, phone_e164, communication_preferences",
        )
        .order("customer_id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        shopCandidates.push({
          id: r.customer_id,
          emailLower: r.email_lower,
          phoneE164: r.phone_e164,
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
        .from("patients")
        .select(PATIENT_CANDIDATE_COLUMNS)
        .eq("status", "active")
        .order("id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) patientCandidates.push(toPatientCandidate(r));
      if (data.length < BATCH) break;
    }
  } else if (input.audienceKind === "by_patient_payer") {
    // PAGINATED — see the note above; a popular payer can exceed the
    // ~1000-row cap and would otherwise be silently truncated.
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .from("patients")
        .select(PATIENT_CANDIDATE_COLUMNS)
        .eq("status", "active")
        .eq("insurance_payer", input.audiencePayer ?? "")
        .order("id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) patientCandidates.push(toPatientCandidate(r));
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
      await loadPatientsByIds(supabase, [...patientIds], patientCandidates);
    }
  } else if (input.audienceKind === "patient_segment") {
    if (input.patientSegment) {
      await fetchPatientSegment(
        supabase,
        input.patientSegment,
        patientCandidates,
      );
    }
  } else if (input.audienceKind === "manual_list") {
    const shopIds = input.manualShopCustomerIds ?? [];
    for (let i = 0; i < shopIds.length; i += BATCH) {
      const slice = shopIds.slice(i, i + BATCH);
      const { data, error } = await supabase
        .from("shop_customers")
        .select(
          "customer_id, email_lower, phone_e164, communication_preferences",
        )
        .in("customer_id", slice);
      if (error) throw error;
      for (const r of data ?? []) {
        shopCandidates.push({
          id: r.customer_id,
          emailLower: r.email_lower,
          phoneE164: r.phone_e164,
          communicationPreferences:
            r.communication_preferences as ShopCustomerCandidate["communicationPreferences"],
        });
      }
    }
    await loadPatientsByIds(
      supabase,
      input.manualPatientIds ?? [],
      patientCandidates,
    );
  }

  return { shopCandidates, patientCandidates };
}

/** Load patient candidate rows for a set of ids, batched under the
 *  PostgREST URL cap. Appends onto `out`. */
async function loadPatientsByIds(
  supabase: OrgScopedClient,
  ids: string[],
  out: PatientCandidate[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    if (slice.length === 0) continue;
    const { data, error } = await supabase
      .from("patients")
      .select(PATIENT_CANDIDATE_COLUMNS)
      .in("id", slice);
    if (error) throw error;
    for (const r of data ?? []) out.push(toPatientCandidate(r));
  }
}

/**
 * Resolve a composable patient segment to its candidate patients.
 *
 * Each criterion that's set narrows the audience (AND semantics):
 *   - equipment (manufacturer / device class / model) → an id set from
 *     resupply.equipment_assets (active assets only).
 *   - therapyFailing → an id set from open low-adherence compliance alerts.
 *   - notContactedInDays → an EXCLUSION set of patients contacted within
 *     the window (never-contacted patients pass through).
 * The base patient query (active patients, optionally payer-filtered) is
 * then intersected against those sets.
 */
async function fetchPatientSegment(
  supabase: OrgScopedClient,
  seg: PatientSegmentFilter,
  out: PatientCandidate[],
): Promise<void> {
  // ── 1. Equipment restriction ───────────────────────────────────────
  let equipmentIds: Set<string> | null = null;
  if (segmentHasEquipmentCriteria(seg)) {
    equipmentIds = new Set<string>();
    const wantedMakes = (seg.manufacturers ?? []).map((m) =>
      m.trim().toLowerCase(),
    );
    for (let from = 0; ; from += BATCH) {
      let query = supabase
        .from("equipment_assets")
        .select("patient_id, manufacturer, device_class, model")
        .eq("status", "active");
      if (seg.deviceClasses && seg.deviceClasses.length > 0) {
        query = query.in("device_class", seg.deviceClasses);
      }
      if (seg.equipmentModelContains) {
        query = query.ilike(
          "model",
          `%${escapeLikePattern(seg.equipmentModelContains)}%`,
        );
      }
      const { data, error } = await query
        .order("patient_id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (!r.patient_id) continue;
        // Manufacturer is free text, so match case-insensitively in app
        // code rather than relying on an exact PostgREST `.in`.
        if (wantedMakes.length > 0) {
          const make = (r.manufacturer ?? "").trim().toLowerCase();
          if (!wantedMakes.includes(make)) continue;
        }
        equipmentIds.add(r.patient_id);
      }
      if (data.length < BATCH) break;
    }
    // Short-circuit: an equipment filter that matched nobody means the
    // whole segment is empty.
    if (equipmentIds.size === 0) return;
  }

  // ── 2. Failing-therapy restriction ─────────────────────────────────
  let therapyIds: Set<string> | null = null;
  if (seg.therapyFailing) {
    therapyIds = new Set<string>();
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .from("csr_compliance_alerts")
        .select("patient_id")
        .eq("status", "open")
        .eq("alert_type", "low_usage")
        .order("patient_id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (r.patient_id) therapyIds.add(r.patient_id);
      }
      if (data.length < BATCH) break;
    }
    if (therapyIds.size === 0) return;
  }

  // ── 3. Contact-recency EXCLUSION set ───────────────────────────────
  let recentlyContactedIds: Set<string> | null = null;
  if (typeof seg.notContactedInDays === "number") {
    recentlyContactedIds = new Set<string>();
    const cutoffIso = new Date(
      Date.now() - seg.notContactedInDays * 86_400_000,
    ).toISOString();
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .from("patient_latest_message")
        .select("patient_id, last_message_at")
        .gte("last_message_at", cutoffIso)
        .order("patient_id", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (r.patient_id) recentlyContactedIds.add(r.patient_id);
      }
      if (data.length < BATCH) break;
    }
  }

  // ── 4. Base active-patient scan, intersected with the sets above ────
  const payer = seg.insurancePayer?.trim();
  for (let from = 0; ; from += BATCH) {
    let query = supabase
      .from("patients")
      .select(PATIENT_CANDIDATE_COLUMNS)
      .eq("status", "active");
    if (payer) {
      query = query.eq("insurance_payer", payer);
    }
    const { data, error } = await query
      .order("id", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (equipmentIds && !equipmentIds.has(r.id)) continue;
      if (therapyIds && !therapyIds.has(r.id)) continue;
      if (recentlyContactedIds && recentlyContactedIds.has(r.id)) continue;
      out.push(toPatientCandidate(r));
    }
    if (data.length < BATCH) break;
  }
}
