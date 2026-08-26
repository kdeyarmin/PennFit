// bootstrap-prescriptions.ts — seed standard resupply Rx lines (+ episodes)
// for active patients who have none yet.
//
// Typical use: after a PacWare roster import created patients but not
// prescriptions. Each line uses DEFAULT_MEDICARE_RESUPPLY_LINES; cadence
// is resolved through resolveOutreachPlan so frequency_rules apply.

import {
  DEFAULT_MEDICARE_RESUPPLY_LINES,
  resolveOutreachPlan,
  type OutreachChannel,
  type OutreachRule,
} from "@workspace/resupply-domain";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { openOutreachEpisode } from "../episodes/open-outreach-episode.js";
import { logger } from "../logger.js";

const PAGE_SIZE = 500;

type PatientRow = {
  id: string;
  created_at: string;
  insurance_payer: string | null;
  cadence_override_days: number | null;
  channel_preference: string | null;
  phone_e164: string | null;
  pacware_id: string | null;
};

function mapRules(
  rows: Array<{
    id: string;
    priority: number;
    created_at: string;
    active: boolean;
    match_item_sku_prefix: string | null;
    match_insurance_payer: string | null;
    min_tenure_days: number | null;
    max_tenure_days: number | null;
    cadence_days: number;
    default_channel: string | null;
  }>,
): OutreachRule[] {
  return rows.map((r) => ({
    id: r.id,
    priority: r.priority,
    createdAt: new Date(r.created_at),
    active: r.active,
    matchItemSkuPrefix: r.match_item_sku_prefix,
    matchInsurancePayer: r.match_insurance_payer,
    minTenureDays: r.min_tenure_days,
    maxTenureDays: r.max_tenure_days,
    cadenceDays: r.cadence_days,
    defaultChannel: r.default_channel as OutreachChannel | null,
  }));
}

async function loadActiveRules(orgId: string): Promise<OutreachRule[]> {
  const { data, error } = await getOrgScopedClient(orgId)
    .from("frequency_rules")
    .select(
      "id, priority, created_at, active, match_item_sku_prefix, match_insurance_payer, min_tenure_days, max_tenure_days, cadence_days, default_channel",
    )
    .eq("active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return mapRules(data ?? []);
}

async function loadPatientsWithActivePrescriptions(
  orgId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await getOrgScopedClient(orgId)
      .from("prescriptions")
      .select("patient_id")
      .eq("status", "active")
      .order("patient_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    for (const row of batch) {
      ids.add((row as { patient_id: string }).patient_id);
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return ids;
}

async function loadEligiblePatients(
  orgId: string,
  opts: { onlyPacwarePatients: boolean },
): Promise<PatientRow[]> {
  const withRx = await loadPatientsWithActivePrescriptions(orgId);
  const eligible: PatientRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = getOrgScopedClient(orgId)
      .from("patients")
      .select(
        "id, created_at, insurance_payer, cadence_override_days, channel_preference, phone_e164, pacware_id",
      )
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (opts.onlyPacwarePatients) {
      query = query.not("pacware_id", "is", null);
    }
    const { data, error } = await query;
    if (error) throw error;
    const batch = (data ?? []) as PatientRow[];
    for (const p of batch) {
      if (!withRx.has(p.id)) eligible.push(p);
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return eligible;
}

export interface BootstrapPrescriptionsInput {
  orgId: string;
  /** When true, only patients with a PacWare id (typical post-import cohort). */
  onlyPacwarePatients?: boolean;
  now?: Date;
}

export interface BootstrapPrescriptionsPreview {
  mode: "preview";
  eligiblePatients: number;
  linesPerPatient: number;
  prescriptionsToCreate: number;
  lineSkus: string[];
  onlyPacwarePatients: boolean;
}

export interface BootstrapPrescriptionsCommit {
  mode: "commit";
  eligiblePatients: number;
  patientsBootstrapped: number;
  prescriptionsCreated: number;
  episodesOpened: number;
  episodeOpenFailures: number;
  onlyPacwarePatients: boolean;
}

export async function previewBootstrapPrescriptions(
  input: BootstrapPrescriptionsInput,
): Promise<BootstrapPrescriptionsPreview> {
  const onlyPacwarePatients = input.onlyPacwarePatients ?? true;
  const eligible = await loadEligiblePatients(input.orgId, {
    onlyPacwarePatients,
  });
  const lines = DEFAULT_MEDICARE_RESUPPLY_LINES;
  return {
    mode: "preview",
    eligiblePatients: eligible.length,
    linesPerPatient: lines.length,
    prescriptionsToCreate: eligible.length * lines.length,
    lineSkus: lines.map((l) => l.itemSku),
    onlyPacwarePatients,
  };
}

export async function commitBootstrapPrescriptions(
  input: BootstrapPrescriptionsInput,
): Promise<BootstrapPrescriptionsCommit> {
  const orgId = input.orgId;
  const onlyPacwarePatients = input.onlyPacwarePatients ?? true;
  const now = input.now ?? new Date();
  const validFrom = now.toISOString().slice(0, 10);

  const [rules, eligible] = await Promise.all([
    loadActiveRules(orgId),
    loadEligiblePatients(orgId, { onlyPacwarePatients }),
  ]);

  const supabase = getOrgScopedClient(orgId);
  let prescriptionsCreated = 0;
  let episodesOpened = 0;
  let episodeOpenFailures = 0;

  for (const patient of eligible) {
    for (const line of DEFAULT_MEDICARE_RESUPPLY_LINES) {
      const plan = resolveOutreachPlan({
        patient: {
          id: patient.id,
          createdAt: new Date(patient.created_at),
          insurancePayer: patient.insurance_payer,
          cadenceOverrideDays: patient.cadence_override_days,
          channelPreference:
            patient.channel_preference as OutreachChannel | null,
          hasPhone: patient.phone_e164 != null,
        },
        prescription: {
          itemSku: line.itemSku,
          cadenceDays: line.cadenceDays,
        },
        rules,
        now,
      });

      const { data: rx, error: rxErr } = await supabase
        .from("prescriptions")
        .insert({
          patient_id: patient.id,
          item_sku: line.itemSku,
          cadence_days: plan.cadenceDays,
          valid_from: validFrom,
          valid_until: null,
          status: "active",
        })
        .select("id")
        .single();
      if (rxErr) {
        logger.warn(
          {
            event: "bootstrap_prescription_insert_failed",
            patient_id: patient.id,
            item_sku: line.itemSku,
            err: rxErr.message,
          },
          "bootstrap-prescriptions: insert failed",
        );
        continue;
      }
      prescriptionsCreated += 1;

      try {
        const opened = await openOutreachEpisode({
          orgId,
          patientId: patient.id,
          prescriptionId: rx.id,
          cadenceDays: plan.cadenceDays,
          from: now,
        });
        if (opened.created) episodesOpened += 1;
      } catch (err) {
        episodeOpenFailures += 1;
        logger.warn(
          {
            event: "bootstrap_episode_open_failed",
            patient_id: patient.id,
            prescription_id: rx.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "bootstrap-prescriptions: openOutreachEpisode failed",
        );
      }
    }
  }

  return {
    mode: "commit",
    eligiblePatients: eligible.length,
    patientsBootstrapped: eligible.length,
    prescriptionsCreated,
    episodesOpened,
    episodeOpenFailures,
    onlyPacwarePatients,
  };
}
