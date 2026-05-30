// pg-boss job: nightly bulk-sync of therapy-integration snapshots.
//
// Walks every patient_therapy_links row with status='active' across
// all sources whose adapter is `configured` (or `stub` — stub still
// produces deterministic snapshots in dev/preview), refreshes each
// patient's snapshot, and persists the recentNights into the
// canonical patient_therapy_nights table.
//
// Throttling: 200ms sleep between calls so a partner with rate
// limits doesn't 429 us. For a population of ~5K active patients
// this puts the tick ceiling around 20 minutes — well under
// pg-boss's stall threshold.
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

import { getIntegrationAdapters } from "../../lib/integrations/registry.js";
import { persistTherapyNights } from "../../lib/integrations/persist-nights.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const THERAPY_NIGHTLY_SYNC_JOB = "therapy-integrations.nightly-sync";

const SYSTEM_ACTOR_EMAIL = "system:worker:therapy-sync";
const THROTTLE_MS = 200;

type Json =
  Database["resupply"]["Tables"]["patient_integration_snapshots"]["Row"]["payload"];

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function registerTherapyNightlySyncJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    THERAPY_NIGHTLY_SYNC_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
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
  const adapters = getIntegrationAdapters();
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
    .limit(5000);
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
        await supabase
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
        await supabase
          .schema("resupply")
          .from("patient_therapy_links")
          .update({
            last_synced_at: fetchedAtIso,
            last_sync_status: "error",
            last_sync_error: fetched.error,
          })
          .eq("id", link.id);
        result.failed += 1;
        await sleep(THROTTLE_MS);
        continue;
      }

      const parsed = integrationSnapshotSchema.safeParse(fetched.snapshot);
      if (!parsed.success) {
        result.failed += 1;
        await sleep(THROTTLE_MS);
        continue;
      }

      await supabase
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
      await supabase
        .schema("resupply")
        .from("patient_therapy_links")
        .update({
          last_synced_at: fetchedAtIso,
          last_sync_status: "ok",
          last_sync_error: null,
        })
        .eq("id", link.id);

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
        "nightly-sync: adapter fetch threw",
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

  return result;
}
