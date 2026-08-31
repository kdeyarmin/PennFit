// pg-boss job: the resupply cycle safety net.
//
// Two sweeps, one tick, because they answer the same question from
// opposite ends — "this cycle has stopped moving; what now?"
//
// 1. SHIP-EVIDENCE GRACE. An order was confirmed and queued, and no
//    shipment confirmation ever arrived. Without this the patient falls
//    out of resupply permanently: the ladder's only producer is
//    `openOutreachEpisode`, which now runs off shipment evidence, and a
//    tenant with no PacWare feed produces none. After a tenant-tunable
//    grace window the next cycle opens anyway, anchored on QUEUE time —
//    which is exactly what the cadence math already used before shipment
//    evidence existed, so a no-ship-feed tenant's ladder is unchanged.
//
//    The episode closes `fulfilled` / **`assumed_shipped`**, and the
//    sweep NEVER touches `fulfillments.shipped_at`. That is the
//    load-bearing rule of this file: `shipped_at` becomes the date of
//    service on an 837P (lib/billing/claim-builder.ts:197). Inventing a
//    ship date for a payer is a compliance problem, not a data-quality
//    one. `assumed_shipped` is the honest marker, and a tenant that later
//    installs a ship feed watches that bucket collapse.
//
// 2. EXPIRY. An episode ran past `expires_at` with no answer at all.
//    `expires_at` has existed since migration 0000 with no writer and no
//    reader; the `expired` status and the /admin/episodes?status=expired
//    filter existed and could never match anything.
//
//    Expiring WITHOUT reopening would remove the patient from resupply
//    permanently and silently — the same trap as (1) — so an expiry also
//    opens the next cycle, dated from now.
//
//    `no_response` and `never_contacted` are recorded separately. One is
//    a patient who ignored us; the other is a patient we never actually
//    reached (no phone, no email, permanent quiet hours, a worker
//    outage). They need different fixes, so the funnel must not merge
//    them.
//
// PHI: counts and ids only. No names, no contact details.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";
import { OUTREACH_OPEN_EPISODE_STATUSES } from "@workspace/resupply-domain";

import { getTenantConfigValue } from "../../lib/app-config/store";
import { closeEpisode } from "../../lib/episodes/close-episode";
import { openOutreachEpisode } from "../../lib/episodes/open-outreach-episode";
import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const JOB = "resupply.cycle-sweep";
// Daily, offset from dwo.expiry-sweep (04:37) and the reminder escalation
// sweep (18:00) so three tenant fan-outs do not stack.
const CRON = "23 5 * * *";

const PAGE_SIZE = 1000;
const READ_CHUNK = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default grace window before a queued order is assumed shipped. */
export const SHIP_GRACE_DAYS = 14;
export const SHIP_GRACE_DAYS_KEY = "RESUPPLY_SHIP_EVIDENCE_GRACE_DAYS";
const GRACE_MIN = 3;
const GRACE_MAX = 90;

/**
 * Parse + clamp the tenant's grace window. Pure, so the clamping is
 * unit-testable without a DB — same shape as `resolveEscalationTiming`.
 *
 * Below GRACE_MIN a normal warehouse turnaround would be called a missing
 * shipment; above GRACE_MAX a patient waits three months for a refill
 * nobody is chasing.
 */
export function resolveShipGraceDays(raw: string | null): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return SHIP_GRACE_DAYS;
  return Math.min(GRACE_MAX, Math.max(GRACE_MIN, n));
}

export interface CycleSweepStats {
  scannedFulfillments: number;
  laddersAdvanced: number;
  episodesAssumed: number;
  scannedExpiring: number;
  episodesExpired: number;
  neverContacted: number;
  failures: number;
}

function emptyStats(): CycleSweepStats {
  return {
    scannedFulfillments: 0,
    laddersAdvanced: 0,
    episodesAssumed: 0,
    scannedExpiring: 0,
    episodesExpired: 0,
    neverContacted: 0,
    failures: 0,
  };
}

export async function registerResupplyCycleSweepJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    try {
      const stats = await runResupplyCycleSweep();
      logger.info(
        { event: "resupply.cycle-sweep.completed", ...stats },
        "resupply.cycle-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "resupply.cycle-sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "resupply.cycle-sweep scheduled");
}

export async function runResupplyCycleSweep(
  now: Date = new Date(),
): Promise<CycleSweepStats> {
  const total = emptyStats();
  await forEachActiveOrg(
    async (orgId) => {
      const stats = await runResupplyCycleSweepForOrg(orgId, now);
      for (const k of Object.keys(total) as (keyof CycleSweepStats)[]) {
        total[k] += stats[k];
      }
    },
    { jobName: JOB },
  );
  return total;
}

export async function runResupplyCycleSweepForOrg(
  orgId: string,
  now: Date = new Date(),
): Promise<CycleSweepStats> {
  const stats = emptyStats();
  const supabase = getOrgScopedClient(orgId);

  const graceDays = resolveShipGraceDays(
    await getTenantConfigValue(orgId, SHIP_GRACE_DAYS_KEY).catch(() => null),
  );

  // ── 1. Ship-evidence grace ──────────────────────────────────────────
  //
  // `status = 'queued'` only. An `on_hold` line is parked on an open
  // address change — we have TOLD the patient nothing is shipping, so
  // advancing their ladder would nag them about an order we deliberately
  // stopped.
  const graceCutoff = new Date(
    now.getTime() - graceDays * DAY_MS,
  ).toISOString();

  const stale: Array<{
    id: string;
    episode_id: string | null;
    created_at: string;
  }> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("fulfillments")
      .select("id, episode_id, created_at")
      .eq("status", "queued")
      .is("shipped_at", null)
      .lte("created_at", graceCutoff)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    stale.push(
      ...(data as Array<{
        id: string;
        episode_id: string | null;
        created_at: string;
      }>),
    );
    if (data.length < PAGE_SIZE) break;
  }
  stats.scannedFulfillments = stale.length;

  for (const row of stale) {
    if (!row.episode_id) continue;
    try {
      const advanced = await advanceLadderWithoutEvidence({
        orgId,
        episodeId: row.episode_id,
        anchor: new Date(row.created_at),
      });
      if (advanced.nextOpened) stats.laddersAdvanced += 1;
      if (advanced.closed) stats.episodesAssumed += 1;
    } catch (err) {
      stats.failures += 1;
      logger.warn(
        {
          event: "resupply.cycle_sweep_grace_failed",
          episodeId: row.episode_id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "resupply.cycle-sweep: grace advance failed",
      );
    }
  }

  // ── 2. Expiry ───────────────────────────────────────────────────────
  const nowIso = now.toISOString();
  const expiring: Array<{
    id: string;
    patient_id: string;
    prescription_id: string;
  }> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("episodes")
      .select("id, patient_id, prescription_id")
      .in("status", [...OUTREACH_OPEN_EPISODE_STATUSES])
      .not("expires_at", "is", null)
      .lte("expires_at", nowIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    expiring.push(
      ...(data as Array<{
        id: string;
        patient_id: string;
        prescription_id: string;
      }>),
    );
    if (data.length < PAGE_SIZE) break;
  }
  stats.scannedExpiring = expiring.length;

  // Which of these were ever actually contacted. A patient we never
  // reached is a different failure from one who ignored us.
  const contacted = await episodesWithOutreach(
    supabase,
    expiring.map((e) => e.id),
  );

  for (const episode of expiring) {
    const everContacted = contacted.has(episode.id);
    try {
      const closed = await closeEpisode({
        orgId,
        episodeId: episode.id,
        patientId: episode.patient_id,
        status: "expired",
        reason: everContacted ? "no_response" : "never_contacted",
        at: now,
      });
      if (!closed.closed) continue;
      stats.episodesExpired += 1;
      if (!everContacted) stats.neverContacted += 1;

      // Reopen, or the patient leaves resupply for good.
      await reopenNextCycle({
        orgId,
        patientId: episode.patient_id,
        prescriptionId: episode.prescription_id,
        from: now,
      });
    } catch (err) {
      stats.failures += 1;
      logger.warn(
        {
          event: "resupply.cycle_sweep_expiry_failed",
          episodeId: episode.id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "resupply.cycle-sweep: expiry failed",
      );
    }
  }

  return stats;
}

/**
 * Close a confirmed cycle as `assumed_shipped` and open the next one,
 * anchored on when the order was QUEUED.
 *
 * Queue-time anchoring is not a compromise — it is exactly what the
 * cadence predicate already used (`COALESCE(shipped_at, created_at)`),
 * so a tenant that never installs a ship feed sees no change at all.
 */
async function advanceLadderWithoutEvidence(args: {
  orgId: string;
  episodeId: string;
  anchor: Date;
}): Promise<{ closed: boolean; nextOpened: boolean }> {
  const supabase = getOrgScopedClient(args.orgId);

  const { data: episode, error } = await supabase
    .from("episodes")
    .select("id, status, patient_id, prescription_id")
    .eq("id", args.episodeId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const ep = episode as {
    status: string;
    patient_id: string;
    prescription_id: string;
  } | null;
  // Only a CONFIRMED cycle is assumed shipped. One still in outreach has
  // not been agreed to; one already terminal is somebody else's business.
  if (!ep || ep.status !== "confirmed") {
    return { closed: false, nextOpened: false };
  }

  const closed = await closeEpisode({
    orgId: args.orgId,
    episodeId: args.episodeId,
    patientId: ep.patient_id,
    status: "fulfilled",
    reason: "assumed_shipped",
    at: args.anchor,
    allowFromConfirmed: true,
  });
  if (!closed.closed) return { closed: false, nextOpened: false };

  const next = await reopenNextCycle({
    orgId: args.orgId,
    patientId: ep.patient_id,
    prescriptionId: ep.prescription_id,
    from: args.anchor,
  });
  return { closed: true, nextOpened: next };
}

/** Open the next cycle for an ACTIVE prescription. Returns false when the
 *  prescription has been deactivated — that is the clinician's decision
 *  and the sweep must not override it. */
async function reopenNextCycle(args: {
  orgId: string;
  patientId: string;
  prescriptionId: string;
  from: Date;
}): Promise<boolean> {
  const supabase = getOrgScopedClient(args.orgId);
  const { data, error } = await supabase
    .from("prescriptions")
    .select("cadence_days, status")
    .eq("id", args.prescriptionId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const rx = data as { cadence_days: number | null; status: string } | null;
  if (!rx || rx.status !== "active") return false;

  const cadenceDays =
    typeof rx.cadence_days === "number" && rx.cadence_days > 0
      ? rx.cadence_days
      : 90;

  const opened = await openOutreachEpisode({
    orgId: args.orgId,
    patientId: args.patientId,
    prescriptionId: args.prescriptionId,
    cadenceDays,
    from: args.from,
  });
  return opened.created;
}

/** Episode ids that had at least one conversation — i.e. we actually
 *  reached out. Chunked at READ_CHUNK for the PostgREST URL limit and
 *  paged inside each chunk, since conversations accumulate over time. */
async function episodesWithOutreach(
  supabase: ReturnType<typeof getOrgScopedClient>,
  episodeIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < episodeIds.length; i += READ_CHUNK) {
    const chunk = episodeIds.slice(i, i + READ_CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("conversations")
        .select("episode_id")
        .in("episode_id", chunk)
        .order("episode_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const c of data as Array<{ episode_id: string | null }>) {
        if (c.episode_id) found.add(c.episode_id);
      }
      if (data.length < PAGE_SIZE) break;
    }
  }
  return found;
}

export const __testing = { resolveShipGraceDays };
