// asset-recovery.auto-populate — nightly scan that opens asset-recovery
// cases from discontinuation signals, so a device can be recovered and
// redeployed without a human spotting the lapse first.
//
// Signal (v1): an UNDISMISSED `usage_dropping` smart-trigger event in the
// recent lookback window — the clearest "this patient may be stopping
// therapy" marker the app already computes. (Lapse-based candidates from
// patient_therapy_nights are a future addition.)
//
// Flag-gated: only runs when `asset_recovery.auto_populate` is ON (seeded
// OFF, migration 0342) — so cases are created only manually via the admin
// UI until an operator opts in.
//
// Tenancy: signals are read with the service-role client (system scan,
// cross-org by nature); new cases are WRITTEN through the org-scoped
// client so org_id is set. While the platform is single-tenant the seed
// org covers every patient; per-patient org resolution is a later step.
//
// PHI / log posture: logs counts only — never patient ids or labels in
// the completion line. The case row stores patient_label (PHI) as the
// other asset-recovery writes do.

import type PgBoss from "pg-boss";

import {
  getOrgScopedClient,
  getSupabaseServiceRoleClient,
  resolveSeedOrgId,
} from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const JOB_NAME = "asset-recovery.auto-populate";
// 04:45 UTC daily — after the nightly therapy sync (04:00) so the
// freshest smart-trigger events are in.
const JOB_CRON = "45 4 * * *";

// Only act on triggers detected recently; an old, never-dismissed
// trigger isn't fresh evidence of a current lapse.
const TRIGGER_LOOKBACK_DAYS = 30;
// Cap work per run so a backlog can't open thousands of cases at once.
const PER_RUN_MAX = 200;
// Cases in these statuses are closed; a patient with only a closed case
// is eligible for a fresh one.
const TERMINAL_STATUSES = new Set<string>(["redeployed", "closed_unrecovered"]);
const SYSTEM_ACTOR = "system:cron:asset-recovery-auto-populate";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export interface AutoPopulateStats {
  enabled: boolean;
  candidates: number;
  created: number;
  skipped: number;
  failed: number;
}

export async function runAssetRecoveryAutoPopulate(): Promise<AutoPopulateStats> {
  const stats: AutoPopulateStats = {
    enabled: false,
    candidates: 0,
    created: 0,
    skipped: 0,
    failed: 0,
  };

  if (!(await isFeatureEnabled("asset_recovery.auto_populate"))) {
    return stats;
  }
  stats.enabled = true;

  const orgId = await resolveSeedOrgId();
  if (!orgId) {
    logger.warn(
      { event: "asset-recovery.auto-populate.no_org" },
      "asset-recovery.auto-populate: no seed org resolved; skipping",
    );
    return stats;
  }

  const supabase = getSupabaseServiceRoleClient();
  const db = getOrgScopedClient(orgId);

  // 1. Candidate patients: undismissed usage_dropping triggers, recent.
  const { data: triggers, error: trigErr } = await supabase
    .schema("resupply")
    .from("patient_smart_trigger_events")
    .select("patient_id")
    .eq("kind", "usage_dropping")
    .is("dismissed_at", null)
    .gte("detected_at", isoDaysAgo(TRIGGER_LOOKBACK_DAYS))
    .limit(2000);
  if (trigErr) throw trigErr;

  const patientIds = [
    ...new Set(
      (triggers ?? [])
        .map((t) => (t as { patient_id: string | null }).patient_id)
        .filter((id): id is string => !!id),
    ),
  ].slice(0, PER_RUN_MAX);
  stats.candidates = patientIds.length;
  if (patientIds.length === 0) return stats;

  // 2. Dedup: patients that already have a non-terminal case.
  const { data: existing, error: existErr } = await db
    .from("asset_recovery_cases")
    .select("patient_id, status")
    .in("patient_id", patientIds);
  if (existErr) throw existErr;
  const existingRows = (existing ?? []) as Array<{
    patient_id: string | null;
    status: string;
  }>;
  const alreadyOpen = new Set(
    existingRows
      .filter((c) => !TERMINAL_STATUSES.has(c.status))
      .map((c) => c.patient_id)
      .filter((id): id is string => !!id),
  );

  // 3. Patient display labels for the new cases.
  const { data: pats } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name")
    .in("id", patientIds);
  const labelById = new Map<string, string | null>(
    (pats ?? []).map((p) => {
      const row = p as {
        id: string;
        legal_first_name: string | null;
        legal_last_name: string | null;
      };
      const label =
        [row.legal_first_name, row.legal_last_name]
          .filter((s) => !!s && s.trim())
          .join(" ")
          .trim() || null;
      return [row.id, label];
    }),
  );

  // 4. Open one case per remaining patient (org_id auto-injected).
  for (const pid of patientIds) {
    if (alreadyOpen.has(pid)) {
      stats.skipped += 1;
      continue;
    }
    const { error: insErr } = await db.from("asset_recovery_cases").insert({
      patient_id: pid,
      patient_label: labelById.get(pid) ?? null,
      reason: "discontinued",
      notes: "Auto-opened from a usage_dropping smart-trigger signal.",
      created_by_email: SYSTEM_ACTOR,
      updated_by_email: SYSTEM_ACTOR,
    });
    if (insErr) {
      stats.failed += 1;
      logger.warn(
        { err: insErr, event: "asset-recovery.auto-populate.insert_failed" },
        "asset-recovery.auto-populate: case insert failed",
      );
      continue;
    }
    stats.created += 1;
  }

  return stats;
}

export async function registerAssetRecoveryAutoPopulateJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, JOB_NAME, CRON_SCAN_QUEUE_OPTS);

  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runAssetRecoveryAutoPopulate();
      logger.info(
        { event: "asset-recovery.auto-populate.completed", ...stats },
        "asset-recovery.auto-populate: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "asset-recovery.auto-populate: failed",
      );
      throw err;
    }
  });

  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "asset-recovery.auto-populate scheduled");
}
