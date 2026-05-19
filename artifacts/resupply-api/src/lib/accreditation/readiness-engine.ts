// Accreditation survey-readiness engine.
//
// CMS finalized annual unannounced DMEPOS surveys effective
// 2026-01-01. The cheapest way to pass an unannounced visit is to
// run the same checks the surveyor will run BEFORE they show up.
//
// This engine runs a structured set of checks against the live data
// surveyors care about — staff training currency, policy attestation
// coverage, retention-sweep results, patient-grievance close rate,
// MFA enrollment, license expiry — and writes the result into
// accreditation_readiness_runs + accreditation_readiness_findings.
//
// One run produces:
//   * the run row with overall_status + counts
//   * one findings row per check (always — even passes get an 'ok'
//     row so the timeline has consistent coverage)
//
// PHI posture: findings carry the structural pointer (table + id)
// only — never the patient's name or any clinical detail.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type Severity = "ok" | "warning" | "error";

export interface RunResult {
  runId: string;
  organizationId: string;
  overallStatus: "ready" | "gaps" | "blocking" | "errored";
  checksTotal: number;
  checksPassed: number;
  checksWarning: number;
  checksFailed: number;
}

interface Finding {
  checkKey: string;
  category:
    | "training"
    | "policy_attestation"
    | "patient_documents"
    | "grievances"
    | "equipment_maintenance"
    | "audit_log"
    | "mfa"
    | "identity"
    | "license_expiry"
    // Phase 10 / migration 0141 compliance categories.
    | "baa_expiry"
    | "oig_screening"
    | "risk_assessment"
    | "contingency_plan"
    | "qi_program";
  severity: Severity;
  label: string;
  detail: string;
  targetTable?: string;
  targetId?: string;
}

const HIPAA_TRAINING_WINDOW_DAYS = 365;
const POLICY_ATTESTATION_WINDOW_DAYS = 365;
const GRIEVANCE_RESOLUTION_TARGET_DAYS = 30;

export async function runAccreditationReadiness(): Promise<RunResult | null> {
  const supabase = getSupabaseServiceRoleClient();

  // Identify the singleton organization. Without an org row we
  // surface a single blocking finding and bail.
  const { data: org } = await supabase
    .schema("resupply")
    .from("dme_organization")
    .select(
      "id, accreditation_expires_on, state_license_expires_on, liability_expires_on, surety_bond_expires_on",
    )
    .eq("singleton", true)
    .limit(1)
    .maybeSingle();
  if (!org) {
    logger.warn(
      "accreditation-readiness: no dme_organization row; skipping run",
    );
    return null;
  }

  // Open the run row.
  const { data: runRow, error: runErr } = await supabase
    .schema("resupply")
    .from("accreditation_readiness_runs")
    .insert({ organization_id: org.id })
    .select("id")
    .single();
  if (runErr) throw runErr;

  const findings: Finding[] = [];

  await checkHipaaTrainingCurrency(supabase, findings);
  await checkPolicyAttestationCoverage(supabase, findings);
  await checkRetentionSweeps(supabase, findings);
  await checkGrievanceTurnaround(supabase, findings);
  await checkAuditLogHealth(supabase, findings);
  await checkMfaCoverage(supabase, findings);
  checkOrgExpiries(org, findings);
  // Phase 10 (migration 0141) compliance machinery checks.
  await checkBaaExpiry(supabase, findings);
  await checkOigScreeningCurrency(supabase, findings);
  await checkRiskAssessmentCurrency(supabase, findings);
  await checkContingencyPlanAttestation(supabase, findings);
  await checkQiProgramHealth(supabase, findings);

  // Persist findings.
  if (findings.length > 0) {
    await supabase
      .schema("resupply")
      .from("accreditation_readiness_findings")
      .insert(
        findings.map((f) => ({
          run_id: runRow.id,
          check_key: f.checkKey,
          category: f.category,
          severity: f.severity,
          label: f.label,
          detail: f.detail,
          target_table: f.targetTable ?? null,
          target_id: f.targetId ?? null,
        })),
      );
  }

  // Roll up + finalize the run.
  const passed = findings.filter((f) => f.severity === "ok").length;
  const warning = findings.filter((f) => f.severity === "warning").length;
  const failed = findings.filter((f) => f.severity === "error").length;
  const overall: RunResult["overallStatus"] =
    failed > 0 ? "blocking" : warning > 0 ? "gaps" : "ready";

  await supabase
    .schema("resupply")
    .from("accreditation_readiness_runs")
    .update({
      completed_at: new Date().toISOString(),
      overall_status: overall,
      checks_total: findings.length,
      checks_passed: passed,
      checks_warning: warning,
      checks_failed: failed,
    })
    .eq("id", runRow.id);

  logger.info(
    {
      event: "accreditation-readiness.completed",
      runId: runRow.id,
      overall,
      total: findings.length,
      passed,
      warning,
      failed,
    },
    "accreditation-readiness: completed",
  );

  return {
    runId: runRow.id,
    organizationId: org.id,
    overallStatus: overall,
    checksTotal: findings.length,
    checksPassed: passed,
    checksWarning: warning,
    checksFailed: failed,
  };
}

// ── Individual checks ───────────────────────────────────────────────

async function checkHipaaTrainingCurrency(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const cutoff = new Date(
    Date.now() - HIPAA_TRAINING_WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const { data: stale } = await supabase
    .schema("resupply")
    .from("staff_training_records")
    .select("id, staff_user_id, training_type, completed_at")
    .in("training_type", ["hipaa_privacy", "hipaa_security"])
    .lte("completed_at", cutoff)
    .limit(50);
  if (stale && stale.length > 0) {
    out.push({
      checkKey: "hipaa_training_stale",
      category: "training",
      severity: "error",
      label: `${stale.length} staff member(s) overdue for HIPAA training`,
      detail:
        "Annual HIPAA training is a Conditions of Participation requirement; surveyors verify completion dates within 365 days.",
    });
  } else {
    out.push({
      checkKey: "hipaa_training_stale",
      category: "training",
      severity: "ok",
      label: "HIPAA training current for all staff",
      detail: "All recorded HIPAA completions are within the 365-day window.",
    });
  }
}

async function checkPolicyAttestationCoverage(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const cutoff = new Date(
    Date.now() - POLICY_ATTESTATION_WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  // Count distinct active policies; count attestations within window.
  // "Active" = active_at IS NOT NULL AND retired_at IS NULL.
  const { data: policies } = await supabase
    .schema("resupply")
    .from("accreditation_policies")
    .select("id, active_at, retired_at")
    .not("active_at", "is", null)
    .is("retired_at", null);
  const policyIds = (policies ?? []).map((p) => p.id);
  if (policyIds.length === 0) {
    out.push({
      checkKey: "policy_attestation_coverage",
      category: "policy_attestation",
      severity: "warning",
      label: "No active accreditation policies on file",
      detail:
        "Surveyors expect a written policy catalog. Seed accreditation_policies with the ACHC/BOC/TJC required policies.",
    });
    return;
  }
  // Sample-driven check: any policy with zero recent attestations is a gap.
  const { data: recentAttestations } = await supabase
    .schema("resupply")
    .from("admin_policy_attestations")
    .select("policy_id, attested_at")
    .gte("attested_at", cutoff);
  const attestedIds = new Set(
    (recentAttestations ?? []).map((a) => a.policy_id),
  );
  const uncovered = policyIds.filter((id) => !attestedIds.has(id));
  if (uncovered.length > 0) {
    out.push({
      checkKey: "policy_attestation_coverage",
      category: "policy_attestation",
      severity: "warning",
      label: `${uncovered.length} active policies lack attestations in the last 365 days`,
      detail:
        "Each active policy needs at least one staff attestation in the survey window.",
    });
  } else {
    out.push({
      checkKey: "policy_attestation_coverage",
      category: "policy_attestation",
      severity: "ok",
      label: "Every active policy has recent attestations",
      detail: `Coverage across ${policyIds.length} active policies.`,
    });
  }
}

async function checkRetentionSweeps(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  // Look for patient_documents past retention but not yet swept.
  const cutoff = new Date(
    Date.now() - 7 * 365 * 24 * 3600 * 1000, // HIPAA medical record retention: 6-10 years; we flag at 7+.
  )
    .toISOString()
    .slice(0, 10);
  const { data: stale } = await supabase
    .schema("resupply")
    .from("patient_documents")
    .select("id, created_at")
    .lte("created_at", cutoff)
    .is("destroyed_at", null)
    .limit(20);
  if (stale && stale.length >= 5) {
    out.push({
      checkKey: "patient_documents_retention",
      category: "patient_documents",
      severity: "warning",
      label: `${stale.length}+ patient documents past 7-year retention`,
      detail:
        "Configure or fire the patient_documents_retention sweep; surveyors check destruction logs.",
    });
  } else {
    out.push({
      checkKey: "patient_documents_retention",
      category: "patient_documents",
      severity: "ok",
      label: "Patient document retention within tolerance",
      detail:
        stale && stale.length > 0
          ? `${stale.length} doc(s) past 7 years; sweep them or apply legal hold.`
          : "No undestroyed documents past 7 years.",
    });
  }
}

async function checkGrievanceTurnaround(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const cutoff = new Date(
    Date.now() - GRIEVANCE_RESOLUTION_TARGET_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const { data: stale } = await supabase
    .schema("resupply")
    .from("patient_grievances")
    .select("id, received_at")
    .lte("received_at", cutoff)
    .neq("status", "resolved")
    .limit(20);
  if (stale && stale.length > 0) {
    out.push({
      checkKey: "grievance_turnaround",
      category: "grievances",
      severity: stale.length >= 5 ? "error" : "warning",
      label: `${stale.length} grievance(s) open past 30 days`,
      detail:
        "ACHC requires acknowledgment within 5 days and resolution targets per policy.",
    });
  } else {
    out.push({
      checkKey: "grievance_turnaround",
      category: "grievances",
      severity: "ok",
      label: "All grievances resolved within 30-day window",
      detail: "No grievance has been open longer than 30 days.",
    });
  }
}

async function checkAuditLogHealth(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  // Any write within the last 24h means the audit chain is alive.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await supabase
    .schema("resupply")
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .gte("occurred_at", cutoff);
  if ((count ?? 0) === 0) {
    out.push({
      checkKey: "audit_log_alive",
      category: "audit_log",
      severity: "error",
      label: "No audit_log writes in the last 24 hours",
      detail:
        "HIPAA §164.312(b) — audit chain may be broken or the application is not logging.",
    });
  } else {
    out.push({
      checkKey: "audit_log_alive",
      category: "audit_log",
      severity: "ok",
      label: "Audit log is writing",
      detail: `${count} audit rows in the last 24 hours.`,
    });
  }
}

async function checkMfaCoverage(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const { count: totalAdmins } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("id", { count: "exact", head: true });
  const { count: mfaEnrolled } = await supabase
    .schema("resupply")
    .from("admin_mfa_secrets")
    .select("staff_user_id", { count: "exact", head: true })
    .not("verified_at", "is", null);
  const total = totalAdmins ?? 0;
  const enrolled = mfaEnrolled ?? 0;
  if (total === 0) {
    out.push({
      checkKey: "mfa_coverage",
      category: "mfa",
      severity: "warning",
      label: "No admin_users rows to assess MFA coverage",
      detail: "Seed the team table first.",
    });
    return;
  }
  const ratio = enrolled / total;
  if (ratio < 1) {
    out.push({
      checkKey: "mfa_coverage",
      category: "mfa",
      severity: ratio < 0.5 ? "error" : "warning",
      label: `${enrolled}/${total} admins have verified MFA`,
      detail:
        "HHS HIPAA Security Rule NPRM (2025) proposes mandatory MFA for all ePHI access.",
    });
  } else {
    out.push({
      checkKey: "mfa_coverage",
      category: "mfa",
      severity: "ok",
      label: `All ${total} admins have verified MFA`,
      detail: "Aligned with the HIPAA Security Rule NPRM expectations.",
    });
  }
}

function checkOrgExpiries(
  org: {
    accreditation_expires_on: string | null;
    state_license_expires_on: string | null;
    liability_expires_on: string | null;
    surety_bond_expires_on: string | null;
  },
  out: Finding[],
): void {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 60 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const checks: Array<{ key: string; label: string; date: string | null }> = [
    {
      key: "accreditation_expiry",
      label: "Accreditation certificate",
      date: org.accreditation_expires_on,
    },
    {
      key: "state_license_expiry",
      label: "State license",
      date: org.state_license_expires_on,
    },
    {
      key: "liability_insurance_expiry",
      label: "Liability insurance",
      date: org.liability_expires_on,
    },
    {
      key: "surety_bond_expiry",
      label: "DMEPOS surety bond",
      date: org.surety_bond_expires_on,
    },
  ];
  for (const c of checks) {
    if (!c.date) {
      out.push({
        checkKey: c.key,
        category: "license_expiry",
        severity: "warning",
        label: `${c.label} expiry not on file`,
        detail: "Populate the dme_organization expiry date for survey readiness.",
      });
      continue;
    }
    if (c.date < today) {
      out.push({
        checkKey: c.key,
        category: "license_expiry",
        severity: "error",
        label: `${c.label} EXPIRED on ${c.date}`,
        detail: "Surveyors will fail this finding on the spot.",
      });
    } else if (c.date <= soon) {
      out.push({
        checkKey: c.key,
        category: "license_expiry",
        severity: "warning",
        label: `${c.label} expires on ${c.date} (within 60 days)`,
        detail: "Renew before the survey window.",
      });
    } else {
      out.push({
        checkKey: c.key,
        category: "license_expiry",
        severity: "ok",
        label: `${c.label} valid through ${c.date}`,
        detail: "Outside the 60-day warning window.",
      });
    }
  }
}

// ── Phase 10 compliance machinery checks (migration 0141) ───────────

const BAA_EXPIRY_WARN_DAYS = 60;
const OIG_SCREENING_OVERDUE_DAYS = 35;
const RISK_ASSESSMENT_MAX_AGE_DAYS = 400;
const CONTINGENCY_ATTESTATION_MAX_AGE_DAYS = 400;
const QI_MEASUREMENT_MAX_AGE_DAYS = 100;
const QI_MIN_ACTIVE_INITIATIVES = 4;

async function checkBaaExpiry(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const warnCutoff = new Date(
    Date.now() + BAA_EXPIRY_WARN_DAYS * 24 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const { data } = await supabase
    .schema("resupply")
    .from("business_associate_agreements")
    .select("id, vendor_slug, status, agreement_expires_on")
    .neq("status", "terminated");
  if (!data || data.length === 0) {
    out.push({
      checkKey: "baa_inventory_empty",
      category: "baa_expiry",
      severity: "error",
      label: "No business-associate agreements on file",
      detail:
        "HIPAA §164.504(e) requires a signed BAA with every BA that touches PHI. The inventory is empty.",
    });
    return;
  }
  const expired = data.filter(
    (r) => r.agreement_expires_on && r.agreement_expires_on < today,
  );
  const expiringSoon = data.filter(
    (r) =>
      r.agreement_expires_on &&
      r.agreement_expires_on >= today &&
      r.agreement_expires_on <= warnCutoff,
  );
  if (expired.length > 0) {
    out.push({
      checkKey: "baa_expired",
      category: "baa_expiry",
      severity: "error",
      label: `${expired.length} BAA(s) expired and not renewed`,
      detail:
        "Disclosure of PHI to a BA without a current BAA is a §164.504(e) violation. Renew or terminate the relationship.",
    });
  } else if (expiringSoon.length > 0) {
    out.push({
      checkKey: "baa_expiring_soon",
      category: "baa_expiry",
      severity: "warning",
      label: `${expiringSoon.length} BAA(s) expiring within ${BAA_EXPIRY_WARN_DAYS} days`,
      detail: "Renew before expiry to avoid a §164.504(e) gap.",
    });
  } else {
    out.push({
      checkKey: "baa_inventory_current",
      category: "baa_expiry",
      severity: "ok",
      label: `${data.length} active BAA(s) — all current`,
      detail: "No expired BAAs and none expiring in the warning window.",
    });
  }
}

async function checkOigScreeningCurrency(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const cutoff = new Date(
    Date.now() - OIG_SCREENING_OVERDUE_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const { data: any_recent } = await supabase
    .schema("resupply")
    .from("oig_leie_screenings")
    .select("id, screened_at")
    .gte("screened_at", cutoff)
    .limit(1);
  if (!any_recent || any_recent.length === 0) {
    out.push({
      checkKey: "oig_screening_overdue",
      category: "oig_screening",
      severity: "error",
      label: "No OIG LEIE screening in the last 35 days",
      detail:
        "OIG SAB 2013 requires monthly screening of every workforce member, contractor, vendor, and ordering provider.",
    });
    return;
  }
  const { data: hits } = await supabase
    .schema("resupply")
    .from("oig_leie_screenings")
    .select("id, subject_label, screened_at")
    .eq("result", "hit")
    .order("screened_at", { ascending: false })
    .limit(5);
  if (hits && hits.length > 0) {
    out.push({
      checkKey: "oig_screening_hit",
      category: "oig_screening",
      severity: "error",
      label: `${hits.length} unresolved OIG LEIE hit(s)`,
      detail:
        "Each hit must be resolved (verified as a false match or the subject terminated) before survey.",
    });
    return;
  }
  out.push({
    checkKey: "oig_screening_current",
    category: "oig_screening",
    severity: "ok",
    label: "OIG LEIE screening current",
    detail: "Most recent screening within the 35-day window; no unresolved hits.",
  });
}

async function checkRiskAssessmentCurrency(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const cutoff = new Date(
    Date.now() - RISK_ASSESSMENT_MAX_AGE_DAYS * 24 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const { data } = await supabase
    .schema("resupply")
    .from("hipaa_risk_assessments")
    .select("id, assessment_year, completed_on")
    .gte("completed_on", cutoff)
    .order("completed_on", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) {
    out.push({
      checkKey: "risk_assessment_stale",
      category: "risk_assessment",
      severity: "error",
      label: "No HIPAA risk analysis completed in the last ~13 months",
      detail:
        "§164.308(a)(1)(ii)(A) requires periodic risk analysis; annual is the de facto standard.",
    });
    return;
  }
  out.push({
    checkKey: "risk_assessment_current",
    category: "risk_assessment",
    severity: "ok",
    label: `Risk assessment ${data[0].assessment_year} completed on ${data[0].completed_on}`,
    detail: "Within the annual cadence.",
  });
}

async function checkContingencyPlanAttestation(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const cutoff = new Date(
    Date.now() - CONTINGENCY_ATTESTATION_MAX_AGE_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const { data } = await supabase
    .schema("resupply")
    .from("contingency_plan_attestations")
    .select("id, plan_version, attested_at")
    .gte("attested_at", cutoff)
    .order("attested_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) {
    out.push({
      checkKey: "contingency_plan_stale",
      category: "contingency_plan",
      severity: "error",
      label: "No contingency plan attestation in the last ~13 months",
      detail:
        "§164.308(a)(7) requires a documented contingency plan with periodic attestation that it is current.",
    });
    return;
  }
  out.push({
    checkKey: "contingency_plan_current",
    category: "contingency_plan",
    severity: "ok",
    label: `Contingency plan ${data[0].plan_version} attested on ${data[0].attested_at.slice(0, 10)}`,
    detail: "Within the annual attestation window.",
  });
}

async function checkQiProgramHealth(
  supabase: SupabaseClient,
  out: Finding[],
): Promise<void> {
  const { data: active } = await supabase
    .schema("resupply")
    .from("quality_improvement_initiatives")
    .select("id, slug")
    .eq("status", "active");
  const activeCount = active?.length ?? 0;
  if (activeCount < QI_MIN_ACTIVE_INITIATIVES) {
    out.push({
      checkKey: "qi_initiatives_too_few",
      category: "qi_program",
      severity: "error",
      label: `${activeCount} active QI initiative(s) — ACHC expects at least ${QI_MIN_ACTIVE_INITIATIVES}`,
      detail:
        "ACHC QAPI standard QM-1 requires ≥4 indicators tracked quarterly. Add or reactivate initiatives.",
    });
    return;
  }
  const cutoff = new Date(
    Date.now() - QI_MEASUREMENT_MAX_AGE_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const initiativeIds = (active ?? []).map((i) => i.id);
  const { data: recentMeasurements } = await supabase
    .schema("resupply")
    .from("quality_improvement_measurements")
    .select("initiative_id, recorded_at")
    .in("initiative_id", initiativeIds)
    .gte("recorded_at", cutoff);
  const measured = new Set(
    (recentMeasurements ?? []).map((m) => m.initiative_id),
  );
  const stale = initiativeIds.filter((id) => !measured.has(id));
  if (stale.length > 0) {
    out.push({
      checkKey: "qi_measurements_stale",
      category: "qi_program",
      severity: "warning",
      label: `${stale.length} active initiative(s) missing a recent measurement`,
      detail:
        "QAPI indicators must be measured quarterly. Record this quarter's measurement before the survey.",
    });
    return;
  }
  out.push({
    checkKey: "qi_program_healthy",
    category: "qi_program",
    severity: "ok",
    label: `${activeCount} active QI initiative(s) with quarterly measurements`,
    detail: "QAPI program meets ACHC QM-1 cadence + coverage expectations.",
  });
}
