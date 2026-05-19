// GET /admin/compliance/officer-summary
//
// Single round-trip the compliance officer loads every morning.
// Consolidates the rollups across every register the Phase 10
// compliance machinery introduced PLUS the pre-existing accreditation
// surfaces, so the officer doesn't have to bounce between 10 routes
// to find the next thing that needs attention.
//
// What's in the response:
//
//   * BAA inventory health — active count + expired count +
//     expiring-soon count.
//   * OIG LEIE screening — last sync, last-screened-at, unresolved
//     hit count.
//   * Patient rights — open requests + due-soon / overdue counts +
//     longest-pending received_at.
//   * Disclosures — count in the last 30 days + last entry.
//   * Risk assessment — most recent year + completed_on + staleness
//     flag.
//   * Contingency plan — last attestation + most recent drill.
//   * QAPI — active initiative count + initiatives missing a recent
//     measurement.
//   * Ownership disclosures — active count.
//   * Training currency — overdue HIPAA training count.
//   * Grievances — open count + median age.
//   * Accreditation readiness — most recent run status + counts.
//
// PHI posture: aggregate counts and structural id/slug fields only.
// No patient names, no recipient addresses from the disclosure log.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { bucketizeRightsClock } from "../../lib/compliance/patient-rights-clock";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/compliance/officer-summary",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const now = Date.now();
    const asOfIso = new Date(now).toISOString();
    const today = asOfIso.slice(0, 10);
    const t30d = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    const t35d = new Date(now - 35 * 24 * 3600 * 1000).toISOString();
    const t100d = new Date(now - 100 * 24 * 3600 * 1000).toISOString();
    const t400d = new Date(now - 400 * 24 * 3600 * 1000).toISOString();
    const baaExpiringCutoff = new Date(now + 60 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);

    const [
      { data: baas },
      { data: lastOigSync },
      { data: lastOigScreening },
      { data: openOigHits },
      { data: openRights },
      { data: disclosures30d },
      { data: latestDisclosure },
      { data: latestRisk },
      { data: latestAttestation },
      { data: latestDrill },
      { data: qiActive },
      { data: qiMeasurements },
      { data: ownership },
      { data: staleTraining },
      { data: openGrievances },
      { data: latestReadiness },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("business_associate_agreements")
        .select("id, status, agreement_expires_on, vendor_slug, vendor_kind"),
      supabase
        .schema("resupply")
        .from("oig_leie_exclusions")
        .select("loaded_at, source_file_version")
        .order("loaded_at", { ascending: false })
        .limit(1),
      supabase
        .schema("resupply")
        .from("oig_leie_screenings")
        .select("screened_at")
        .order("screened_at", { ascending: false })
        .limit(1),
      supabase
        .schema("resupply")
        .from("oig_leie_screenings")
        .select("id, subject_label, screened_at")
        .eq("result", "hit")
        .order("screened_at", { ascending: false }),
      supabase
        .schema("resupply")
        .from("patient_rights_requests")
        .select("id, request_kind, status, received_at, extension_granted_at")
        .in("status", ["received", "in_review", "extended"]),
      supabase
        .schema("resupply")
        .from("patient_disclosure_log")
        .select("id")
        .gte("disclosed_at", t30d),
      supabase
        .schema("resupply")
        .from("patient_disclosure_log")
        .select("id, disclosure_purpose, disclosed_at")
        .order("disclosed_at", { ascending: false })
        .limit(1),
      supabase
        .schema("resupply")
        .from("hipaa_risk_assessments")
        .select("id, assessment_year, completed_on, approved_at")
        .order("completed_on", { ascending: false })
        .limit(1),
      supabase
        .schema("resupply")
        .from("contingency_plan_attestations")
        .select("id, plan_version, attested_at, documented_rto_hours")
        .order("attested_at", { ascending: false })
        .limit(1),
      supabase
        .schema("resupply")
        .from("disaster_preparedness_drills")
        .select("id, drill_kind, executed_on")
        .order("executed_on", { ascending: false })
        .limit(1),
      supabase
        .schema("resupply")
        .from("quality_improvement_initiatives")
        .select("id, slug, category")
        .eq("status", "active"),
      supabase
        .schema("resupply")
        .from("quality_improvement_measurements")
        .select("initiative_id, recorded_at")
        .gte("recorded_at", t100d),
      supabase
        .schema("resupply")
        .from("dme_ownership_disclosures")
        .select("id, person_role")
        .is("removed_on", null),
      supabase
        .schema("resupply")
        .from("staff_training_records")
        .select("id")
        .in("training_type", ["hipaa_privacy", "hipaa_security"])
        .lte("completed_at", t400d),
      supabase
        .schema("resupply")
        .from("patient_grievances")
        .select("id, received_at, status")
        .in("status", ["open", "acknowledged", "escalated", "reopened"]),
      supabase
        .schema("resupply")
        .from("accreditation_readiness_runs")
        .select(
          "id, completed_at, overall_status, checks_total, checks_passed, checks_warning, checks_failed",
        )
        .order("started_at", { ascending: false })
        .limit(1),
    ]);

    // ── BAA rollup ────────────────────────────────────────────────
    const baaActive = (baas ?? []).filter((b) => b.status === "active");
    const baaExpired = baaActive.filter(
      (b) => b.agreement_expires_on && b.agreement_expires_on < today,
    );
    const baaExpiringSoon = baaActive.filter(
      (b) =>
        b.agreement_expires_on &&
        b.agreement_expires_on >= today &&
        b.agreement_expires_on <= baaExpiringCutoff,
    );

    // ── OIG rollup ────────────────────────────────────────────────
    const lastSyncedAt = lastOigSync?.[0]?.loaded_at ?? null;
    const lastScreenedAt = lastOigScreening?.[0]?.screened_at ?? null;
    const oigOverdue = !lastScreenedAt || lastScreenedAt < t35d;

    // ── Rights rollup ─────────────────────────────────────────────
    let dueSoon = 0;
    let overdue = 0;
    let oldestReceivedAt: string | null = null;
    for (const r of openRights ?? []) {
      const bucket = bucketizeRightsClock({
        receivedAt: r.received_at,
        extensionGrantedAt: r.extension_granted_at,
        status: r.status,
        asOf: asOfIso,
      });
      if (bucket === "due_soon") dueSoon += 1;
      if (bucket === "extension_eligible" || bucket === "extension_overdue") {
        overdue += 1;
      }
      if (!oldestReceivedAt || r.received_at < oldestReceivedAt) {
        oldestReceivedAt = r.received_at;
      }
    }

    // ── Risk assessment rollup ────────────────────────────────────
    const riskRow = latestRisk?.[0] ?? null;
    const riskStale =
      !riskRow ||
      (riskRow.completed_on && riskRow.completed_on < t400d.slice(0, 10));

    // ── Contingency / drill rollup ────────────────────────────────
    const attestation = latestAttestation?.[0] ?? null;
    const contingencyStale =
      !attestation || (attestation.attested_at ?? "") < t400d;
    const drill = latestDrill?.[0] ?? null;

    // ── QI rollup ─────────────────────────────────────────────────
    const measured = new Set(
      (qiMeasurements ?? []).map((m) => m.initiative_id),
    );
    const qiMissingMeasurement = (qiActive ?? []).filter(
      (i) => !measured.has(i.id),
    );

    // ── Grievances rollup ─────────────────────────────────────────
    const ages = (openGrievances ?? [])
      .map((g) => now - new Date(g.received_at).getTime())
      .filter((n) => Number.isFinite(n));
    ages.sort((a, b) => a - b);
    const medianAgeMs = ages.length
      ? ages[Math.floor(ages.length / 2)]
      : null;
    const grievancesMedianAgeDays =
      medianAgeMs === null ? null : Math.round(medianAgeMs / (24 * 3600 * 1000));

    res.json({
      generatedAt: asOfIso,
      baa: {
        active: baaActive.length,
        expired: baaExpired.length,
        expiringSoon: baaExpiringSoon.length,
        terminated: (baas ?? []).filter((b) => b.status === "terminated").length,
      },
      oigLeie: {
        cacheVersion: lastOigSync?.[0]?.source_file_version ?? null,
        cacheLoadedAt: lastSyncedAt,
        lastScreenedAt,
        overdue: oigOverdue,
        unresolvedHits: openOigHits?.length ?? 0,
      },
      patientRights: {
        openCount: openRights?.length ?? 0,
        dueSoonCount: dueSoon,
        overdueCount: overdue,
        oldestReceivedAt,
      },
      disclosures: {
        last30dCount: disclosures30d?.length ?? 0,
        lastEntryAt: latestDisclosure?.[0]?.disclosed_at ?? null,
        lastEntryPurpose: latestDisclosure?.[0]?.disclosure_purpose ?? null,
      },
      riskAssessment: {
        latestYear: riskRow?.assessment_year ?? null,
        completedOn: riskRow?.completed_on ?? null,
        approved: !!riskRow?.approved_at,
        stale: riskStale,
      },
      contingency: {
        lastPlanVersion: attestation?.plan_version ?? null,
        lastAttestedAt: attestation?.attested_at ?? null,
        documentedRtoHours: attestation?.documented_rto_hours ?? null,
        stale: contingencyStale,
        lastDrillKind: drill?.drill_kind ?? null,
        lastDrillOn: drill?.executed_on ?? null,
      },
      qapi: {
        activeInitiatives: qiActive?.length ?? 0,
        missingMeasurementCount: qiMissingMeasurement.length,
        missingMeasurementSlugs: qiMissingMeasurement.map((i) => i.slug),
      },
      ownership: {
        activeCount: ownership?.length ?? 0,
      },
      training: {
        staleHipaaCount: staleTraining?.length ?? 0,
      },
      grievances: {
        openCount: openGrievances?.length ?? 0,
        medianAgeDays: grievancesMedianAgeDays,
      },
      readiness: latestReadiness?.[0] ?? null,
    });
  },
);

export default router;
