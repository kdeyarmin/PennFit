// pg-boss job: nightly bulk-sync of therapy-integration snapshots.
//
// Walks every patient_therapy_links row with status='active' across
// all sources whose adapter is `configured` (or `stub` — stub still
// produces deterministic snapshots in dev/preview), refreshes each
// patient's snapshot, and persists the recentNights into the
// canonical patient_therapy_nights table.
//
// Throttling: 200ms sleep between calls so a partner with rate
// limits doesn't 429 us. Each run processes at most MAX_LINKS_PER_RUN
// links (least-recently-synced first), keeping the tick well under
// pg-boss's stall threshold; a larger active population is covered
// across consecutive nightly runs rather than in a single tick.
//
// Audit: per-link result not individually audited (would explode
// the log). Aggregate completion + failure counts are emitted in
// one summary audit row at the end.

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  type IntegrationSource,
  integrationSnapshotSchema,
} from "@workspace/resupply-integrations";

import { getIntegrationAdaptersWithDbOverrides } from "../../lib/integrations/registry.js";
import { persistTherapyNights } from "../../lib/integrations/persist-nights.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";
import {
  recordIntegrationSuccess,
  recordIntegrationFailure,
} from "../lib/integration-health.js";

export const THERAPY_NIGHTLY_SYNC_JOB = "therapy-integrations.nightly-sync";

const SYSTEM_ACTOR_EMAIL = "system:worker:therapy-sync";
const THROTTLE_MS = 200;
// Per-run ceiling (one PostgREST page). Bounds the throttled fetch loop so
// a tick stays well under the pg-boss lease; a larger active-link
// population is covered across consecutive nightly runs via the
// least-recently-synced ordering on the scan query below.
const MAX_LINKS_PER_RUN = 1000;

type Json =
  Database["resupply"]["Tables"]["patient_integration_snapshots"]["Row"]["payload"];

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Coerce the common per-night vendor quirks that would otherwise fail
 * `integrationSnapshotSchema` and cause the ENTIRE snapshot — valid device
 * settings, compliance, AND every other night — to be dropped for that
 * patient. The adapters copy vendor fields verbatim (`nightDate: raw.date`,
 * `usageMinutes: raw.x`), so a vendor returning a full ISO timestamp, a
 * fractional minute count, or a negative leak reading nukes the whole sync.
 *
 * We normalize in place: ISO timestamps -> YYYY-MM-DD, numerics
 * rounded/clamped to the schema shape (non-negative int | non-negative
 * number | null), drop ONLY the individual nights whose date can't be
 * salvaged, and strip any extra keys (the night schema is exact). Non-night
 * fields are left untouched — a malformed settings/compliance block is a
 * different, rarer failure handled by the safeParse below.
 */
export function normalizeSnapshotForPersistence(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const snap = snapshot as Record<string, unknown>;
  const nights = snap.recentNights;
  if (!Array.isArray(nights)) return snapshot;

  const toDate = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    // Accept YYYY-MM-DD or slice the date prefix off an ISO timestamp.
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m ? m[1]! : null;
  };
  // Fractional positive values are rounded/kept; negative (garbage)
  // readings become null ("no data") rather than a misleading 0.
  const toNonNegInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0
      ? Math.round(v)
      : null;
  const toNonNeg = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

  const normalizedNights = nights.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const n = raw as Record<string, unknown>;
    const nightDate = toDate(n.nightDate);
    if (!nightDate) return []; // unsalvageable date -> drop only this night
    return [
      {
        nightDate,
        usageMinutes: toNonNegInt(n.usageMinutes),
        ahi: toNonNeg(n.ahi),
        leakRateLMin: toNonNeg(n.leakRateLMin),
        pressureP95Cmh2o: toNonNeg(n.pressureP95Cmh2o),
      },
    ];
  });

  return { ...snap, recentNights: normalizedNights };
}

export async function registerTherapyNightlySyncJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, THERAPY_NIGHTLY_SYNC_JOB, {
    ...VENDOR_SEND_QUEUE_OPTS,
    // A full MAX_LINKS_PER_RUN page costs 200s of throttle sleep alone
    // (1000 × 200ms) plus a vendor HTTP fetch and several PostgREST
    // writes per link — realistic worst case is tens of minutes, far
    // past the preset's 15-minute expiry. An expired-but-still-running
    // handler gets retried CONCURRENTLY by pg-boss: two syncs then
    // double-fetch rate-limited vendor APIs and interleave
    // last_synced_at stamps. Budget a full hour instead.
    expireInMinutes: 60,
  });
  await boss.work(THERAPY_NIGHTLY_SYNC_JOB, async () => {
    await runTherapyNightlySync();
  });
  // Schedule daily at 04:30 UTC — earliest hour the partner clouds
  // tend to have finalised the prior night's roll-up.
  await boss.schedule(THERAPY_NIGHTLY_SYNC_JOB, "30 4 * * *");
  logger.info(
    { queue: THERAPY_NIGHTLY_SYNC_JOB },
    "therapy nightly-sync worker registered",
  );
}

export interface NightlySyncResult {
  scanned: number;
  refreshed: number;
  failed: number;
  nightsPersisted: number;
}

export async function runTherapyNightlySync(): Promise<NightlySyncResult> {
  const supabase = getSupabaseServiceRoleClient();
  const adapters = await getIntegrationAdaptersWithDbOverrides();
  const result: NightlySyncResult = {
    scanned: 0,
    refreshed: 0,
    failed: 0,
    nightsPersisted: 0,
  };

  const { data: links, error } = await supabase
    .schema("resupply")
    .from("patient_therapy_links")
    .select("id, patient_id, source, partner_patient_id, status")
    .eq("status", "active")
    // Process the least-recently-synced links first, bounded to one
    // PostgREST page per run. The previous unpaginated read silently
    // truncated at the ~1000-row response cap AND returned an arbitrary
    // order, so the same ~1000 links were re-synced every night and the
    // rest were NEVER synced. Ordering by last_synced_at — stamped on every
    // link below, nulls (never-synced) sorting first — rotates coverage
    // across nights, and the per-run bound keeps the throttled fetch loop
    // within the job lease. A population larger than one page is covered
    // over consecutive nightly runs.
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(MAX_LINKS_PER_RUN);
  if (error) throw error;

  for (const link of links ?? []) {
    result.scanned += 1;
    const source = link.source as IntegrationSource;
    const adapter = adapters.get(source);
    if (!adapter) {
      result.failed += 1;
      continue;
    }
    if (adapter.availability().status === "unavailable") {
      result.failed += 1;
      continue;
    }
    try {
      const fetched = await adapter.fetchSnapshot({
        partnerPatientId: link.partner_patient_id,
      });
      const fetchedAtIso = new Date().toISOString();
      if (!fetched.ok) {
        // Writes must be error-checked: a silently failed
        // `last_synced_at` stamp keeps this link sorting to the front
        // of every night's MAX_LINKS_PER_RUN page, starving the rest
        // of the population — the exact failure mode the ordering
        // above was added to fix. Throw into the per-link catch so it
        // is logged and counted as failed.
        const { error: errSnapErr } = await supabase
          .schema("resupply")
          .from("patient_integration_snapshots")
          .upsert(
            {
              patient_id: link.patient_id,
              source,
              partner_patient_id: link.partner_patient_id,
              payload: {
                source,
                partnerPatientId: link.partner_patient_id,
                settings: null,
                compliance: null,
                recentNights: [],
                supplies: [],
              } as unknown as Json,
              fetch_status: "error",
              fetch_error: fetched.error,
              fetched_at: fetchedAtIso,
            },
            { onConflict: "patient_id,source" },
          );
        if (errSnapErr) throw errSnapErr;
        const { error: errStampErr } = await supabase
          .schema("resupply")
          .from("patient_therapy_links")
          .update({
            last_synced_at: fetchedAtIso,
            last_sync_status: "error",
            last_sync_error: fetched.error,
          })
          .eq("id", link.id);
        if (errStampErr) throw errStampErr;
        result.failed += 1;
        await sleep(THROTTLE_MS);
        continue;
      }

      const parsed = integrationSnapshotSchema.safeParse(
        normalizeSnapshotForPersistence(fetched.snapshot),
      );
      if (!parsed.success) {
        // Previously a silent drop. Log path+code (never raw values — PHI)
        // so a persistently malformed vendor payload is visible to ops
        // instead of just incrementing a counter.
        logger.warn(
          {
            link_id: link.id,
            source,
            issues: parsed.error.issues
              .slice(0, 5)
              .map((i) => ({ path: i.path.join("."), code: i.code })),
          },
          "nightly-sync: snapshot failed schema validation after normalization; dropping",
        );
        result.failed += 1;
        await sleep(THROTTLE_MS);
        continue;
      }

      // Same as the error branch above: a dropped write here both
      // over-reports `refreshed` and (for the stamp) starves rotation.
      const { error: okSnapErr } = await supabase
        .schema("resupply")
        .from("patient_integration_snapshots")
        .upsert(
          {
            patient_id: link.patient_id,
            source,
            partner_patient_id: link.partner_patient_id,
            payload: parsed.data as unknown as Json,
            fetch_status: "ok",
            fetch_error: null,
            fetched_at: fetchedAtIso,
          },
          { onConflict: "patient_id,source" },
        );
      if (okSnapErr) throw okSnapErr;
      const { error: okStampErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_links")
        .update({
          last_synced_at: fetchedAtIso,
          last_sync_status: "ok",
          last_sync_error: null,
        })
        .eq("id", link.id);
      if (okStampErr) throw okStampErr;

      try {
        const r = await persistTherapyNights(
          supabase,
          link.patient_id,
          source,
          parsed.data.recentNights,
        );
        result.nightsPersisted += r.inserted;
      } catch (err) {
        logger.warn(
          { err, link_id: link.id },
          "nightly-sync: persistTherapyNights failed",
        );
      }
      result.refreshed += 1;
    } catch (err) {
      logger.warn(
        { err, link_id: link.id, source },
        "nightly-sync: link sync failed (adapter fetch or persistence write threw)",
      );
      result.failed += 1;
    }
    await sleep(THROTTLE_MS);
  }

  await logAudit({
    action: "therapy.integrations.nightly_sync.completed",
    adminEmail: SYSTEM_ACTOR_EMAIL,
    adminUserId: null,
    targetTable: null,
    targetId: null,
    metadata: {
      scanned: result.scanned,
      refreshed: result.refreshed,
      failed: result.failed,
      nights_persisted: result.nightsPersisted,
    },
    ip: null,
    userAgent: null,
  }).catch((err) => {
    logger.warn({ err }, "nightly_sync completion audit failed");
  });

  // Sustained-failure alerting (W2). A run where every patient failed
  // is indistinguishable from the vendor being down; alert ops after
  // ALERT_THRESHOLD such runs so silence doesn't hide an outage.
  const HIGH_FAILURE_RATE = 0.8;
  const totalFailureRun =
    result.scanned > 0 && result.failed / result.scanned >= HIGH_FAILURE_RATE;
  if (totalFailureRun) {
    await recordIntegrationFailure(
      THERAPY_NIGHTLY_SYNC_JOB,
      `${result.failed}/${result.scanned} links failed (${Math.round((result.failed / result.scanned) * 100)}%)`,
    ).catch(() => undefined);
  } else if (result.scanned > 0) {
    await recordIntegrationSuccess(THERAPY_NIGHTLY_SYNC_JOB).catch(
      () => undefined,
    );
  }

  return result;
}
