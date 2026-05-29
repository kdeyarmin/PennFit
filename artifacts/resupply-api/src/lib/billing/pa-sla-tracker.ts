// PA Medicaid 7-day SLA tracker.
//
// PA DHS OpsMemo 2025-09: Medicaid managed-care MCOs must complete
// standard PA decisions within 7 calendar days from 2026-01-01. The
// MCO is on the hook with the regulator, but as the supplier we
// need to know who is approaching the deadline so we can chase the
// MCO portal before a billing gap opens.
//
// The sweep job runs every 6 hours and stamps:
//   * mco_sla_target_date  = submitted_at + 7 days (Medicaid MCOs)
//   * mco_sla_status:
//     'on_track' = >= 3 days remaining
//     'at_risk'  = <= 2 days remaining
//     'missed'   = past target with no decision_at
//     'decided'  = decision_at IS NOT NULL (terminal)
//
// Side effects:
//   * Inserts CSR compliance alerts for transitions into 'at_risk'
//     and 'missed' (idempotent via the existing alert dedupe key
//     in csr_compliance_alerts.metric_snapshot).

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type PriorAuthRow =
  Database["resupply"]["Tables"]["prior_authorizations"]["Row"];
type SlaStatus = NonNullable<PriorAuthRow["mco_sla_status"]>;

const STANDARD_PA_SLA_DAYS = 7;
const AT_RISK_THRESHOLD_DAYS = 2;
const MEDICAID_MCO_LOBS = new Set(["medicaid_mco"]);

export interface SweepStats {
  scanned: number;
  updated: number;
  alertsCreated: number;
  byStatus: Record<SlaStatus, number>;
}

export async function runPaMcoSlaSweep(): Promise<SweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: SweepStats = {
    scanned: 0,
    updated: 0,
    alertsCreated: 0,
    byStatus: { on_track: 0, at_risk: 0, missed: 0, decided: 0 },
  };

  // Pull every PA that is potentially MCO-bound and currently in a
  // submitted/draft/appealed state. We deliberately include null
  // mco_sla_status so first-time tagging happens here.
  const { data: pas, error } = await supabase
    .schema("resupply")
    .from("prior_authorizations")
    .select(
      "id, patient_id, payer_name, hcpcs_code, status, submitted_at, decision_at, mco_sla_target_date, mco_sla_status, insurance_coverage_id",
    )
    .in("status", ["draft", "submitted", "appealed", "approved"])
    .limit(5000);
  if (error) throw error;

  // Resolve payer LOB once per distinct payer.
  const payerLobMap = await resolvePayerLobMap(supabase, pas ?? []);

  for (const pa of pas ?? []) {
    stats.scanned += 1;
    const isMcoMedicaid = isPaMedicaidMco(pa, payerLobMap);
    if (!isMcoMedicaid) continue;

    if (pa.decision_at) {
      // Terminal — stamp once and move on.
      if (pa.mco_sla_status !== "decided") {
        await supabase
          .schema("resupply")
          .from("prior_authorizations")
          .update({ mco_sla_status: "decided" })
          .eq("id", pa.id);
        stats.updated += 1;
      }
      stats.byStatus.decided += 1;
      continue;
    }
    if (!pa.submitted_at) continue;

    const target = pa.mco_sla_target_date ?? computeTargetDate(pa.submitted_at);
    const next = computeStatus(target);
    stats.byStatus[next] += 1;

    if (pa.mco_sla_status !== next || pa.mco_sla_target_date !== target) {
      await supabase
        .schema("resupply")
        .from("prior_authorizations")
        .update({
          mco_sla_target_date: target,
          mco_sla_status: next,
        })
        .eq("id", pa.id);
      stats.updated += 1;
    }

    // Fire a CSR alert on transitions into at_risk or missed. Use
    // metric_snapshot.priorAuthId for idempotency (matches the
    // existing prior-auth-expiry-sweep pattern).
    if (next === "at_risk" || next === "missed") {
      const alertType =
        next === "at_risk" ? "pa_mco_sla_at_risk" : "pa_mco_sla_missed";
      const { data: existing } = await supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .select("id")
        .eq("patient_id", pa.patient_id)
        .eq("alert_type", alertType)
        .eq("status", "open")
        .filter("metric_snapshot->>priorAuthId", "eq", pa.id)
        .limit(1);
      if (existing && existing.length > 0) continue;
      await supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .insert({
          patient_id: pa.patient_id,
          alert_type: alertType,
          severity: next === "missed" ? "critical" : "warning",
          summary: `MCO PA ${next === "missed" ? "MISSED 7-day SLA" : "approaching 7-day SLA"}: ${pa.hcpcs_code} (${pa.payer_name})`,
          metric_snapshot: {
            priorAuthId: pa.id,
            hcpcsCode: pa.hcpcs_code,
            payerName: pa.payer_name,
            slaTargetDate: target,
            slaStatus: next,
          },
        });
      stats.alertsCreated += 1;
    }
  }

  logger.info(
    { event: "pa-mco-sla-sweep.completed", ...stats },
    "pa-mco-sla-sweep: completed",
  );

  return stats;
}

function computeTargetDate(submittedAt: string): string {
  const d = new Date(submittedAt);
  d.setUTCDate(d.getUTCDate() + STANDARD_PA_SLA_DAYS);
  return d.toISOString().slice(0, 10);
}

function computeStatus(targetDate: string): SlaStatus {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(`${targetDate}T00:00:00Z`);
  const remainingMs = target.getTime() - today.getTime();
  const remainingDays = Math.floor(remainingMs / (24 * 3600 * 1000));
  if (remainingDays < 0) return "missed";
  if (remainingDays <= AT_RISK_THRESHOLD_DAYS) return "at_risk";
  return "on_track";
}

function isPaMedicaidMco(
  pa: Pick<PriorAuthRow, "payer_name" | "insurance_coverage_id">,
  payerLobMap: Map<string, string>,
): boolean {
  if (!pa.insurance_coverage_id) return false;
  const lob = payerLobMap.get(pa.insurance_coverage_id);
  return lob ? MEDICAID_MCO_LOBS.has(lob) : false;
}

async function resolvePayerLobMap(
  supabase: SupabaseClient,
  pas: Array<Pick<PriorAuthRow, "insurance_coverage_id">>,
): Promise<Map<string, string>> {
  const coverageIds = [
    ...new Set(
      pas
        .map((p) => p.insurance_coverage_id)
        .filter((c): c is string => c !== null),
    ),
  ];
  if (coverageIds.length === 0) return new Map();
  const { data: coverages } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select("id, payer_name")
    .in("id", coverageIds);
  const coverageToPayer = new Map<string, string>();
  for (const c of coverages ?? []) {
    coverageToPayer.set(c.id, c.payer_name);
  }
  // Pull payer profile LOB by matching display_name to coverage.payer_name.
  const payerNames = [...new Set(coverageToPayer.values())];
  if (payerNames.length === 0) return new Map();
  const { data: profiles } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("display_name, line_of_business")
    .in("display_name", payerNames);
  const nameToLob = new Map<string, string>();
  for (const p of profiles ?? []) {
    nameToLob.set(p.display_name, p.line_of_business);
  }
  const lobMap = new Map<string, string>();
  for (const [coverageId, name] of coverageToPayer.entries()) {
    const lob = nameToLob.get(name);
    if (lob) lobMap.set(coverageId, lob);
  }
  return lobMap;
}
