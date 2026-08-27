// pg-boss job: release claims stuck in the transient `submitting` lock.
//
// Why this exists
// ---------------
// Office Ally batch submit (migration 0298) flips draft → submitting with a
// conditional UPDATE so two concurrent submitters cannot transmit the same
// claim twice. On a clean path the lock lasts seconds (SFTP upload + status
// flip to submitted). On a crash / killed process / hung transport the rows
// stay `submitting` forever — they drop out of the draft-only batch selector
// and the admin UI is the only escape hatch (VALID_TRANSITIONS allows
// submitting → draft). The Aug-26 workflow review flagged this as High:
// crash mid-upload leaves claims stuck with no automatic recovery.
//
// What this job does
// ------------------
//   1. Per active tenant, find insurance_claims still in `submitting` whose
//      `updated_at` is older than the stale threshold (default 30 min —
//      longer than any healthy SFTP attempt with retries).
//   2. Skip any claim that already carries `office_ally_submission_id` OR
//      appears in a recent office_ally_submissions.attempted_claim_ids for an
//      uploaded/queued file — those may already have reached the
//      clearinghouse, and auto-releasing them to draft would risk a second
//      transmission. Log `needs_manual` counts only (no claim ids / PHI).
//   3. Conditionally UPDATE the rest back to `draft` (status must still be
//      submitting) so a concurrent winner that just finished is never
//      stomped.
//
// Posture
// -------
// Always-on cron (no feature flag). No patient contact. Fan-out via
// forEachActiveOrg. Logs counts/status only — never claim ids in the
// summary event (ids stay in per-row debug paths that we deliberately
// avoid here).

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const CLAIMS_SUBMITTING_WATCHDOG_JOB =
  "billing.claims-submitting-watchdog";

/** Default: every 15 minutes. Override with CLAIMS_SUBMITTING_WATCHDOG_CRON. */
const DEFAULT_CRON = "7,22,37,52 * * * *";

/** Default stale age before a submitting lock is considered abandoned. */
const DEFAULT_STALE_MS = 30 * 60 * 1000;

/** Cap per-tenant releases per tick so a mass incident finishes over ticks. */
const MAX_RELEASE_PER_ORG = 500;

const TRANSMITTED_SUBMISSION_STATUSES = ["uploaded", "queued"] as const;

export interface ClaimsSubmittingWatchdogStats {
  scanned: number;
  released: number;
  needsManual: number;
}

function resolveStaleMs(): number {
  const raw = process.env.CLAIMS_SUBMITTING_WATCHDOG_STALE_MINUTES?.trim();
  if (!raw) return DEFAULT_STALE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 5) return DEFAULT_STALE_MS;
  return Math.floor(minutes) * 60 * 1000;
}

function resolveCron(): string {
  return process.env.CLAIMS_SUBMITTING_WATCHDOG_CRON?.trim() || DEFAULT_CRON;
}

/**
 * Run the watchdog for one tenant. Exported for tests.
 */
export async function runClaimsSubmittingWatchdogForOrg(
  orgId: string,
  opts: { now?: Date; staleMs?: number } = {},
): Promise<ClaimsSubmittingWatchdogStats> {
  const now = opts.now ?? new Date();
  const staleMs = opts.staleMs ?? resolveStaleMs();
  const cutoffIso = new Date(now.getTime() - staleMs).toISOString();
  const supabase = getOrgScopedClient(orgId);

  const { data: stuckRows, error: stuckErr } = await supabase
    .from("insurance_claims")
    .select("id, office_ally_submission_id, updated_at")
    .eq("status", "submitting")
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(MAX_RELEASE_PER_ORG);
  if (stuckErr) throw stuckErr;

  const stuck = (stuckRows ?? []) as Array<{
    id: string;
    office_ally_submission_id: string | null;
    updated_at: string;
  }>;

  const stats: ClaimsSubmittingWatchdogStats = {
    scanned: stuck.length,
    released: 0,
    needsManual: 0,
  };
  if (stuck.length === 0) return stats;

  // Claims that already point at a submission row — treat as transmitted.
  const alreadyLinked = new Set(
    stuck.filter((r) => r.office_ally_submission_id).map((r) => r.id),
  );

  // Also refuse to release anything listed on a recent uploaded/queued
  // submission (covers the "upload ok, claim status update failed" path
  // where office_ally_submission_id was never stamped on the claim).
  const candidateIds = stuck
    .map((r) => r.id)
    .filter((id) => !alreadyLinked.has(id));
  const transmittedIds = new Set<string>(alreadyLinked);

  if (candidateIds.length > 0) {
    const { data: subs, error: subErr } = await supabase
      .from("office_ally_submissions")
      .select("id, attempted_claim_ids, status")
      .in("status", [...TRANSMITTED_SUBMISSION_STATUSES])
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(200);
    if (subErr) throw subErr;
    const candidateSet = new Set(candidateIds);
    for (const sub of (subs ?? []) as Array<{
      attempted_claim_ids: string[] | null;
      status: string;
    }>) {
      for (const id of sub.attempted_claim_ids ?? []) {
        if (candidateSet.has(id)) transmittedIds.add(id);
      }
    }
  }

  const releasable = stuck
    .map((r) => r.id)
    .filter((id) => !transmittedIds.has(id));
  stats.needsManual = transmittedIds.size;

  if (releasable.length === 0) return stats;

  const nowIso = now.toISOString();
  const { data: releasedRows, error: releaseErr } = await supabase
    .from("insurance_claims")
    .update({ status: "draft", updated_at: nowIso })
    .in("id", releasable)
    .eq("status", "submitting")
    .select("id");
  if (releaseErr) throw releaseErr;
  stats.released = ((releasedRows ?? []) as Array<{ id: string }>).length;
  return stats;
}

/**
 * Fan out across every active tenant. One tenant's failure cannot abort
 * the others (`forEachActiveOrg`).
 */
export async function runClaimsSubmittingWatchdog(
  opts: { now?: Date; staleMs?: number } = {},
): Promise<ClaimsSubmittingWatchdogStats> {
  const totals: ClaimsSubmittingWatchdogStats = {
    scanned: 0,
    released: 0,
    needsManual: 0,
  };
  await forEachActiveOrg(
    async (orgId) => {
      const stats = await runClaimsSubmittingWatchdogForOrg(orgId, opts);
      totals.scanned += stats.scanned;
      totals.released += stats.released;
      totals.needsManual += stats.needsManual;
    },
    { jobName: CLAIMS_SUBMITTING_WATCHDOG_JOB },
  );
  return totals;
}

export async function registerClaimsSubmittingWatchdogJob(
  boss: PgBoss,
): Promise<void> {
  const cron = resolveCron();
  await createQueueWithDlq(
    boss,
    CLAIMS_SUBMITTING_WATCHDOG_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );

  await boss.work(CLAIMS_SUBMITTING_WATCHDOG_JOB, async () => {
    try {
      const stats = await runClaimsSubmittingWatchdog();
      logger.info(
        {
          event: "claims_submitting_watchdog.completed",
          stale_ms: resolveStaleMs(),
          ...stats,
        },
        "claims-submitting-watchdog: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "claims-submitting-watchdog: failed",
      );
      throw err;
    }
  });

  await boss.schedule(CLAIMS_SUBMITTING_WATCHDOG_JOB, cron);
  logger.info(
    { cron, stale_ms: resolveStaleMs() },
    "claims-submitting-watchdog scheduled",
  );
}
