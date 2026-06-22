// pg-boss job: daily Medicare ADR SLA sweep.
//
// Why this exists
// ---------------
// claim_adr_requests.sla_status (on_track / at_risk / overdue / decided) is a
// denormalised cache so the ADR worklist can filter + badge by deadline state
// without recomputing per row. The HTTP routes set it on create/update, but a
// row that just sits open as days pass needs its cache advanced — an ADR that
// was "on_track" yesterday is "overdue" the morning after its response_due.
// This sweep walks the open/in_progress ADRs once a day and re-derives the
// status with the SAME pure classifier the routes + UI use, so the worklist
// buckets stay correct over time.
//
// Posture
// -------
// Per-tenant, fan-out via forEachActiveOrg. Gated by the billing.adr_queue
// feature flag PER ORG: when a tenant has the queue off, the sweep is a no-op
// for that tenant. It only UPDATEs rows whose stored status drifted, and never
// touches submitted/closed ADRs (their clock has stopped). It writes no
// alerts and no audit rows — a pure cache refresh.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";
import { classifyAdrSla } from "@workspace/resupply-domain";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const SWEEP_JOB = "billing.adr-sla-sweep";
// Opt-in override; defaults to 04:37 UTC daily (off-peak, after the
// prior-auth sweep at 03:47). The per-org flag gate makes it inert until a
// tenant turns the ADR queue on, so a fixed daily schedule is safe.
const SWEEP_CRON = process.env.ADR_SLA_SWEEP_CRON?.trim() || "37 4 * * *";
const PAGE_SIZE = 1000;

export interface AdrSlaSweepStats {
  scanned: number;
  updated: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runAdrSlaSweepForOrg(
  orgId: string,
  today: Date = new Date(),
): Promise<AdrSlaSweepStats> {
  const stats: AdrSlaSweepStats = { scanned: 0, updated: 0 };
  if (!(await isFeatureEnabled("billing.adr_queue", orgId))) {
    return stats;
  }
  const supabase = getOrgScopedClient(orgId);
  const todayIso = isoDate(today);

  // Snapshot the open set across keyset pages before updating, so flips during
  // the walk don't shift the `status IN (open, in_progress)` window under us.
  const rows: Array<{
    id: string;
    response_due: string | null;
    status: string;
    sla_status: string;
  }> = [];
  let cursor = "";
  for (;;) {
    let q = supabase
      .from("claim_adr_requests")
      .select("id, response_due, status, sla_status")
      .in("status", ["open", "in_progress"])
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as Array<{
      id: string;
      response_due: string | null;
      status: string;
      sla_status: string;
    }>;
    if (page.length === 0) break;
    rows.push(...page);
    cursor = page[page.length - 1]!.id;
    if (page.length < PAGE_SIZE) break;
  }

  for (const row of rows) {
    stats.scanned += 1;
    // open/in_progress are never "decided" — the clock is still running.
    const next = classifyAdrSla(row.response_due, todayIso, {
      decided: false,
    }).status;
    if (next === row.sla_status) continue;
    const { error: updErr } = await supabase
      .from("claim_adr_requests")
      .update({ sla_status: next })
      .eq("id", row.id)
      .in("status", ["open", "in_progress"]);
    if (updErr) {
      logger.warn(
        { err: updErr.message, adrId: row.id },
        "billing.adr-sla-sweep: status update failed",
      );
      continue;
    }
    stats.updated += 1;
  }

  return stats;
}

export async function runAdrSlaSweep(
  today: Date = new Date(),
): Promise<AdrSlaSweepStats> {
  const stats: AdrSlaSweepStats = { scanned: 0, updated: 0 };
  await forEachActiveOrg(
    async (orgId) => {
      const s = await runAdrSlaSweepForOrg(orgId, today);
      stats.scanned += s.scanned;
      stats.updated += s.updated;
    },
    { jobName: SWEEP_JOB },
  );
  return stats;
}

export async function registerAdrSlaSweepJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, SWEEP_JOB, CRON_SCAN_QUEUE_OPTS);

  await boss.work(SWEEP_JOB, async () => {
    try {
      const stats = await runAdrSlaSweep();
      logger.info(
        { event: "billing.adr-sla-sweep.completed", ...stats },
        "billing.adr-sla-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "billing.adr-sla-sweep: failed",
      );
      throw err;
    }
  });

  await boss.schedule(SWEEP_JOB, SWEEP_CRON);
  logger.info({ cron: SWEEP_CRON }, "billing.adr-sla-sweep scheduled");
}
