// pg-boss job: scan for soon-to-expire prescriptions and pre-build
// draft Rx packets so a CSR doesn't have to hunt for them.
//
// Why
// ---
// The "Renew via fax packet" button on PrescriptionsTab still needs
// a CSR to notice the expiring Rx. The single biggest win is
// removing the noticing step — drafts appear in the patient's
// packet queue overnight, and the CSR's morning is review + click
// "Send fax."
//
// Cadence
// -------
// Daily at 13:43 UTC (mid-day; spaced from rx-renewal-send at 13:07
// and the other daily clusters). Gated by
// RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED=1 — off by default in
// dev / preview so the worker doesn't write packets nobody plans to
// send.
//
// What the job does
// -----------------
// 1. SELECT prescriptions WHERE status='active'
//      AND valid_until BETWEEN today AND today + LOOKAHEAD_DAYS
//      AND provider_id IS NOT NULL
//      AND hcpcs_code IS NOT NULL
// 2. For each Rx, skip when a packet already exists for the same
//    source_prescription_id with status IN (draft, sent_fax,
//    delivered, signed) AND created_at >= now() - COOLDOWN_DAYS.
//    This keeps the worker idempotent on re-run within the
//    cool-down window.
// 3. For each candidate, build the packet body via the shared
//    builder helper (same prefill rules as the one-click renewal
//    route) and INSERT.
// 4. Audit one row per packet (system actor) so the morning CSR
//    sees who created the draft.
//
// PHI posture: logger emits Rx id (truncated) + outcome counts.
// Never patient ids, names, or clinical content.

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { buildPrescriptionRequestPacketFromRx } from "../../lib/prescription-request-builder";
import { logger } from "../../lib/logger";

const JOB = "prescription-request.auto-draft";
const CRON = "43 13 * * *"; // 13:43 UTC daily
const LOOKAHEAD_DAYS = 30;
const COOLDOWN_DAYS = 60;
const BATCH_SIZE = 500;
const SYSTEM_ACTOR = "system:cron:prescription-request-auto-draft";

export interface AutoDraftStats {
  scanned: number;
  drafted: number;
  skipped_recent: number;
  skipped_no_provider: number;
  skipped_no_hcpcs: number;
  failed: number;
}

export async function runPrescriptionRequestAutoDraft(): Promise<AutoDraftStats> {
  const stats: AutoDraftStats = {
    scanned: 0,
    drafted: 0,
    skipped_recent: 0,
    skipped_no_provider: 0,
    skipped_no_hcpcs: 0,
    failed: 0,
  };

  const env = process.env;
  if (env.RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED !== "1") {
    logger.info(
      { event: "rx_auto_draft.disabled" },
      "prescription-request.auto-draft: env flag off, skipping",
    );
    return stats;
  }

  const supabase = getSupabaseServiceRoleClient();
  const today = new Date();
  const horizon = new Date(today.getTime() + LOOKAHEAD_DAYS * 86_400_000);
  const cooldownStart = new Date(today.getTime() - COOLDOWN_DAYS * 86_400_000);
  const todayIso = today.toISOString().slice(0, 10);
  const horizonIso = horizon.toISOString().slice(0, 10);

  // Candidate prescriptions — partial pre-filter; provider/hcpcs
  // gate is enforced again per-row by the builder.
  const { data: candidates, error } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select("id, patient_id, provider_id, hcpcs_code, valid_until")
    .eq("status", "active")
    .gte("valid_until", todayIso)
    .lte("valid_until", horizonIso)
    .order("valid_until", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    logger.error(
      { err: error.message },
      "prescription-request.auto-draft.select_failed",
    );
    throw error;
  }
  if (!candidates || candidates.length === 0) return stats;
  stats.scanned = candidates.length;

  // Resolve existing-packet cooldown in one query rather than N+1.
  const rxIds = candidates.map((r) => r.id);
  const { data: recent } = await supabase
    .schema("resupply")
    .from("prescription_request_packets")
    .select("source_prescription_id")
    .in("source_prescription_id", rxIds)
    .in("status", ["draft", "sent_fax", "delivered", "signed"])
    .gte("created_at", cooldownStart.toISOString());
  const skipSet = new Set(
    (recent ?? [])
      .map((p) => p.source_prescription_id)
      .filter((id): id is string => typeof id === "string"),
  );

  for (const rx of candidates) {
    if (!rx.provider_id) {
      stats.skipped_no_provider += 1;
      continue;
    }
    if (!rx.hcpcs_code) {
      stats.skipped_no_hcpcs += 1;
      continue;
    }
    if (skipSet.has(rx.id)) {
      stats.skipped_recent += 1;
      continue;
    }

    const built = await buildPrescriptionRequestPacketFromRx({
      patientId: rx.patient_id,
      prescriptionId: rx.id,
      createdByEmail: SYSTEM_ACTOR,
    });
    if (built.kind !== "ok") {
      // Builder's own miss reasons mirror the pre-filter above —
      // when they diverge (e.g. provider was deleted between the
      // candidate scan and the builder lookup), bin by miss kind.
      if (built.kind === "rx_missing_provider") {
        stats.skipped_no_provider += 1;
      } else if (built.kind === "rx_missing_hcpcs") {
        stats.skipped_no_hcpcs += 1;
      } else {
        stats.failed += 1;
      }
      continue;
    }

    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .insert(built.insert)
      .select("id")
      .maybeSingle();
    if (insertErr || !inserted) {
      stats.failed += 1;
      logger.warn(
        {
          rx_id_first8: rx.id.slice(0, 8),
          err_code: insertErr?.code,
        },
        "prescription-request.auto-draft.insert_failed",
      );
      continue;
    }
    stats.drafted += 1;

    await logAudit({
      action: "prescription_request.auto_drafted",
      adminEmail: SYSTEM_ACTOR,
      adminUserId: null,
      targetTable: "prescription_request_packets",
      targetId: inserted.id,
      metadata: {
        source_prescription_id: rx.id,
      },
      ip: null,
      userAgent: null,
    }).catch((err) => {
      logger.warn(
        { err },
        "prescription-request.auto-draft.audit write failed",
      );
    });
  }

  return stats;
}

export async function registerPrescriptionRequestAutoDraftJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runPrescriptionRequestAutoDraft();
      if (stats.scanned > 0 || stats.drafted > 0) {
        logger.info(
          { event: "prescription-request.auto-draft.completed", ...stats },
          "prescription-request.auto-draft: tick",
        );
      }
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "prescription-request.auto-draft: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "prescription-request.auto-draft scheduled");
}
