// pg-boss job: nightly bulk-sync of therapy-integration snapshots.
//
// Walks every patient_therapy_links row with status='active' across
// all sources whose adapter reports `configured`, refreshes each
// patient's snapshot, and persists the recentNights into the
// canonical patient_therapy_nights table.
//
// (This used to say "or `stub` — stub still produces deterministic
// snapshots in dev/preview". None of the three THERAPY adapters has ever
// returned `stub`; they report `configured` or `unavailable`, and an
// unavailable one returns an error rather than fabricating a snapshot.
// Stub mode belongs to the Office Ally and XPS adapters. The comment
// described a dev convenience that does not exist, which is worse than
// no comment: it suggests a preview environment is exercising this path
// when nothing is.)
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
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";
import {
  type IntegrationSource,
  integrationSnapshotSchema,
} from "@workspace/resupply-integrations";

import { getIntegrationAdaptersForOrg } from "../../lib/integrations/registry.js";
import { persistTherapyNights } from "../../lib/integrations/persist-nights.js";
import { logger } from "../../lib/logger.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
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

// Stamp a link that was skipped before any adapter fetch (no adapter, or
// adapter credentials unavailable) so it rotates to the back of the
// least-recently-synced queue. Without a stamp the link keeps sorting to
// the front of every night's MAX_LINKS_PER_RUN page and starves the rest
// of the population.
async function stampLinkSkipped(
  supabase: ReturnType<typeof getOrgScopedClient>,
  linkId: string,
  status: "adapter_missing" | "adapter_unavailable",
): Promise<void> {
  const { error } = await supabase
    .from("patient_therapy_links")
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: status,
      last_sync_error: status,
    })
    .eq("id", linkId);
  if (error) throw error;
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
 * salvaged, and strip any extra keys (the night schema is exact). The
 * `supplies` array gets the same treatment: its `lastReplacedDate` /
 * `nextEligibleDate` are date-coerced (both are nullable, so an
 * unsalvageable value becomes null rather than dropping the line), and a
 * line whose structural fields (`category` / `description`) are unusable is
 * dropped on its own — so a single vendor supply line returning a full ISO
 * timestamp can no longer nuke the whole snapshot (every valid night,
 * setting, and compliance figure with it). A malformed settings/compliance
 * block is a different, rarer failure still handled by the safeParse below.
 */
// Valid supply categories, mirroring `supplyItemSchema.category`
// (lib/resupply-integrations). A line whose category isn't one of these
// can't satisfy the schema, so it's dropped individually rather than
// failing the whole snapshot.
const SUPPLY_CATEGORIES = new Set([
  "mask",
  "cushion",
  "headgear",
  "tubing",
  "filter",
  "humidifier_chamber",
  "other",
]);

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

  // Observability: dropped nights were previously invisible — a vendor
  // shipping unparseable dates on EVERY night made the sync read as
  // "successful" while persisting zero usage data. Counts only, no
  // night contents (vendor payloads are PHI-adjacent).
  if (normalizedNights.length < nights.length) {
    logger.warn(
      {
        event: "therapy_sync_nights_dropped",
        received: nights.length,
        kept: normalizedNights.length,
      },
      "therapy-nightly-sync: dropped nights with unsalvageable dates during normalization",
    );
  }

  // Supplies get the same salvage treatment. The date fields are nullable,
  // so a non-date value (e.g. a full ISO timestamp) coerces to null rather
  // than dropping the line; only a line with an unusable category/description
  // is dropped on its own. Without this, one bad supply date fails the strict
  // schema and discards the ENTIRE snapshot (the same "reads successful,
  // persists zero data" mode the night normalization prevents).
  const supplies = snap.supplies;
  if (!Array.isArray(supplies)) {
    return { ...snap, recentNights: normalizedNights };
  }
  const normalizedSupplies = supplies.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const s = raw as Record<string, unknown>;
    if (typeof s.category !== "string" || !SUPPLY_CATEGORIES.has(s.category)) {
      return []; // unusable structural field -> drop only this line
    }
    if (typeof s.description !== "string") return [];
    return [
      {
        category: s.category,
        description: s.description,
        lastReplacedDate: toDate(s.lastReplacedDate),
        nextEligibleDate: toDate(s.nextEligibleDate),
      },
    ];
  });
  if (normalizedSupplies.length < supplies.length) {
    logger.warn(
      {
        event: "therapy_sync_supplies_dropped",
        received: supplies.length,
        kept: normalizedSupplies.length,
      },
      "therapy-nightly-sync: dropped supply lines with unusable category/description during normalization",
    );
  }

  return {
    ...snap,
    recentNights: normalizedNights,
    supplies: normalizedSupplies,
  };
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

export async function runTherapyNightlySyncForOrg(
  orgId: string,
): Promise<NightlySyncResult> {
  const supabase = getOrgScopedClient(orgId);
  // Per-tenant adapters: this org's patients are synced against the org's
  // OWN therapy-cloud credentials, not the seed/platform account.
  const adapters = await getIntegrationAdaptersForOrg(orgId);
  const result: NightlySyncResult = {
    scanned: 0,
    refreshed: 0,
    failed: 0,
    nightsPersisted: 0,
  };

  const { data: links, error } = await supabase
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
      // Stamp so a link whose source has no configured adapter rotates to
      // the back of the queue instead of permanently occupying the front
      // of every night's page (rotation starvation). Best-effort: a stamp
      // write failure here must not abort the whole tenant's run.
      await stampLinkSkipped(supabase, link.id, "adapter_missing").catch(
        (err) =>
          logger.warn(
            { err, link_id: link.id, source },
            "nightly-sync: failed to stamp adapter_missing link",
          ),
      );
      result.failed += 1;
      continue;
    }
    if (adapter.availability().status === "unavailable") {
      await stampLinkSkipped(supabase, link.id, "adapter_unavailable").catch(
        (err) =>
          logger.warn(
            { err, link_id: link.id, source },
            "nightly-sync: failed to stamp adapter_unavailable link",
          ),
      );
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
        // Stamp the link (and persist an error snapshot) before continuing,
        // exactly like the fetch-error branch above. Without this, a link
        // with a persistently malformed vendor payload keeps `last_synced_at`
        // null/oldest and sorts to the front of every night's
        // MAX_LINKS_PER_RUN page — starving the rest of the population, the
        // very rotation-starvation failure the ordering was added to fix.
        const { error: invalidSnapErr } = await supabase
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
              fetch_error: "snapshot_failed_schema_validation",
              fetched_at: fetchedAtIso,
            },
            { onConflict: "patient_id,source" },
          );
        if (invalidSnapErr) throw invalidSnapErr;
        const { error: invalidStampErr } = await supabase
          .from("patient_therapy_links")
          .update({
            last_synced_at: fetchedAtIso,
            last_sync_status: "error",
            last_sync_error: "snapshot_failed_schema_validation",
          })
          .eq("id", link.id);
        if (invalidStampErr) throw invalidStampErr;
        result.failed += 1;
        await sleep(THROTTLE_MS);
        continue;
      }

      // Same as the error branch above: a dropped write here both
      // over-reports `refreshed` and (for the stamp) starves rotation.
      const { error: okSnapErr } = await supabase
        .from("patient_integration_snapshots")
        .upsert(
          {
            patient_id: link.patient_id,
            source,
            partner_patient_id: link.partner_patient_id,
            payload: parsed.data as unknown as Json,
            // `partial` when the vendor answered but left a sub-resource
            // empty — no device settings, or no nights in the window.
            // The column has allowed this value since migration 0219 and
            // nothing ever wrote it, so a patient whose therapy feed had
            // gone quiet was recorded identically to one syncing
            // perfectly, and the integrations dashboard counted both as
            // healthy. Distinguishing them is the difference between
            // "this connection is fine" and "this connection is up and
            // returning nothing".
            fetch_status:
              parsed.data.settings == null ||
              (parsed.data.recentNights?.length ?? 0) === 0
                ? "partial"
                : "ok",
            fetch_error: null,
            fetched_at: fetchedAtIso,
          },
          { onConflict: "patient_id,source" },
        );
      if (okSnapErr) throw okSnapErr;
      const { error: okStampErr } = await supabase
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
  // Scope the integration-health counter PER TENANT. This job fans out over
  // every active org (`forEachActiveOrg` below), so a global key lets a
  // healthy tenant processed after a failing one reset the failing tenant's
  // consecutive-failure counter — suppressing its outage alert (and vice
  // versa). Matches the office-ally inbound-poll `${JOB}:${orgId}` pattern.
  const healthKey = `${THERAPY_NIGHTLY_SYNC_JOB}:${orgId}`;
  if (totalFailureRun) {
    await recordIntegrationFailure(
      healthKey,
      `${result.failed}/${result.scanned} links failed (${Math.round((result.failed / result.scanned) * 100)}%)`,
    ).catch(() => undefined);
  } else if (result.scanned > 0) {
    await recordIntegrationSuccess(healthKey).catch(() => undefined);
  }

  return result;
}

/**
 * Run the nightly therapy-cloud sync for EVERY active tenant.
 * `patient_therapy_links` / `patient_integration_snapshots` are
 * tenant-scoped, so the sync fans out via `forEachActiveOrg` (per-tenant
 * error isolation) and sums the counts. Single-tenant behavior is
 * byte-identical to the old seed-org sweep.
 */
export async function runTherapyNightlySync(): Promise<NightlySyncResult> {
  const result: NightlySyncResult = {
    scanned: 0,
    refreshed: 0,
    failed: 0,
    nightsPersisted: 0,
  };
  await forEachActiveOrg(
    async (orgId) => {
      const r = await runTherapyNightlySyncForOrg(orgId);
      result.scanned += r.scanned;
      result.refreshed += r.refreshed;
      result.failed += r.failed;
      result.nightsPersisted += r.nightsPersisted;
    },
    { jobName: THERAPY_NIGHTLY_SYNC_JOB },
  );
  return result;
}
