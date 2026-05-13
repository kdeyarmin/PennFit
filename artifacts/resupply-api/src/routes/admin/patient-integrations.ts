// /admin/patients/:id/integrations — unified "Device data" view
// across ResMed AirView, Philips Care Orchestrator, and Health
// Connect for one patient.
//
//   GET  /admin/patients/:id/integrations
//        Returns the per-source therapy link (if any) + the
//        cached snapshot (if any) + adapter availability. Does
//        not call partner APIs — pure cache read.
//
//   POST /admin/patients/:id/integrations/refresh
//        Body: { source: "resmed_airview" | "philips_care" | "health_connect" }
//        Calls the adapter's fetchSnapshot, validates the result,
//        UPSERTs into patient_integration_snapshots, and returns
//        the fresh row. Errors normalise to fetch_status='error'
//        with a short error code; we still cache the previous
//        successful snapshot so the UI keeps showing the last
//        good data.
//
// PHI / log posture: snapshot payloads contain device serial +
// supply replacement dates (PHI-adjacent). Audit envelopes record
// snapshot id + patient id + source + status only. Logger never
// sees the payload or the partner response body.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import {
  INTEGRATION_SOURCES,
  integrationSnapshotSchema,
  type AdapterAvailability,
  type IntegrationSnapshot,
  type IntegrationSource,
} from "@workspace/resupply-integrations";

import { getIntegrationAdapters } from "../../lib/integrations/registry";
import { persistTherapyNights } from "../../lib/integrations/persist-nights";
import { diffSettings } from "../../lib/integrations/diff-settings";
import { linkEquipmentFromSnapshot } from "../../lib/integrations/link-equipment";
import { scanRecallsForAsset } from "../../lib/integrations/scan-recalls-for-asset";
import { evaluatePatientSmartTriggers } from "../../lib/smart-triggers/evaluate-patient";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.string().uuid();
const refreshBody = z
  .object({
    source: z.enum(INTEGRATION_SOURCES),
  })
  .strict();

interface SnapshotRow {
  id: string;
  payload: unknown;
  fetch_status: string;
  fetch_error: string | null;
  fetched_at: string;
}

interface UnifiedSourceView {
  source: IntegrationSource;
  availability: AdapterAvailability;
  link: {
    id: string;
    partnerPatientId: string;
    deviceSerial: string | null;
    status: string;
    lastSyncedAt: string | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
  } | null;
  snapshot: {
    id: string;
    payload: IntegrationSnapshot;
    fetchStatus: string;
    fetchError: string | null;
    fetchedAt: string;
  } | null;
}

function snapshotRowToView(row: SnapshotRow): UnifiedSourceView["snapshot"] {
  // Re-validate at the boundary: a payload written by an older
  // adapter version may not match the current schema, in which case
  // we treat it as missing rather than crash the route.
  const parsed = integrationSnapshotSchema.safeParse(row.payload);
  if (!parsed.success) return null;
  return {
    id: row.id,
    payload: parsed.data,
    fetchStatus: row.fetch_status,
    fetchError: row.fetch_error,
    // PostgREST already returns timestamptz as ISO string.
    fetchedAt: row.fetched_at,
  };
}

router.get(
  "/admin/patients/:id/integrations",
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const supabase = getSupabaseServiceRoleClient();

    const { data: existsRow, error: existsErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (existsErr) throw existsErr;
    if (!existsRow) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const [linksRes, snapshotsRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patient_therapy_links")
        .select(
          "id, patient_id, source, partner_patient_id, device_serial, status, last_synced_at, last_sync_status, last_sync_error",
        )
        .eq("patient_id", patientId)
        .order("status", { ascending: true })
        .order("source", { ascending: true }),
      supabase
        .schema("resupply")
        .from("patient_integration_snapshots")
        .select(
          "id, source, payload, fetch_status, fetch_error, fetched_at",
        )
        .eq("patient_id", patientId),
    ]);
    if (linksRes.error) throw linksRes.error;
    if (snapshotsRes.error) throw snapshotsRes.error;

    const linkRows = linksRes.data ?? [];
    const snapshotRows = snapshotsRes.data ?? [];

    const adapters = getIntegrationAdapters();
    const linkBySource = new Map<string, (typeof linkRows)[number]>();
    for (const row of linkRows) {
      // Prefer the active link if there are multiple history rows
      // for the same source.
      if (
        !linkBySource.has(row.source) ||
        (row.status === "active" &&
          linkBySource.get(row.source)?.status !== "active")
      ) {
        linkBySource.set(row.source, row);
      }
    }
    const snapBySource = new Map<string, (typeof snapshotRows)[number]>();
    for (const row of snapshotRows) {
      snapBySource.set(row.source, row);
    }

    const sources: UnifiedSourceView[] = INTEGRATION_SOURCES.map((src) => {
      const link = linkBySource.get(src) ?? null;
      const snap = snapBySource.get(src) ?? null;
      return {
        source: src,
        availability: adapters.get(src)!.availability(),
        link: link
          ? {
              id: link.id,
              partnerPatientId: link.partner_patient_id,
              deviceSerial: link.device_serial,
              status: link.status,
              lastSyncedAt: link.last_synced_at,
              lastSyncStatus: link.last_sync_status,
              lastSyncError: link.last_sync_error,
            }
          : null,
        snapshot: snap ? snapshotRowToView(snap) : null,
      };
    });

    res.json({ patientId, sources });
  },
);

router.post(
  "/admin/patients/:id/integrations/refresh",
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const bodyParsed = refreshBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { source } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Look up the active link for this (patient, source). For
    // health_connect there is no link row — the partner-side id
    // is the PennFit patient id (the patient app authenticates
    // as the patient, not via a separate partner account).
    let partnerPatientId: string;
    if (source === "health_connect") {
      const { data: existsRow, error: existsErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle();
      if (existsErr) throw existsErr;
      if (!existsRow) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
      partnerPatientId = patientId;
    } else {
      const { data: link, error: linkErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_links")
        .select("partner_patient_id")
        .eq("patient_id", patientId)
        .eq("source", source)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (linkErr) throw linkErr;
      if (!link) {
        res.status(409).json({
          error: "no_active_link",
          message: `Patient has no active ${source} link. Create one before refreshing.`,
        });
        return;
      }
      partnerPatientId = link.partner_patient_id;
    }

    const adapter = getIntegrationAdapters().get(source);
    if (!adapter) {
      // Should be unreachable — refreshBody validates source is in
      // INTEGRATION_SOURCES and the registry seeds one adapter per
      // source.
      res.status(500).json({ error: "adapter_unavailable" });
      return;
    }

    const result = await adapter.fetchSnapshot({ partnerPatientId });

    let payload: IntegrationSnapshot;
    let fetchStatus: "ok" | "error" = "ok";
    let fetchError: string | null = null;
    if (result.ok) {
      // Validate at the persistence boundary — never trust an
      // adapter to have returned a well-formed snapshot.
      const parsed = integrationSnapshotSchema.safeParse(result.snapshot);
      if (!parsed.success) {
        fetchStatus = "error";
        fetchError = "schema_invalid";
        payload = {
          source,
          partnerPatientId,
          settings: null,
          compliance: null,
          recentNights: [],
          supplies: [],
        };
      } else {
        payload = parsed.data;
      }
    } else {
      fetchStatus = "error";
      fetchError = result.error;
      payload = {
        source,
        partnerPatientId,
        settings: null,
        compliance: null,
        recentNights: [],
        supplies: [],
      };
    }

    // Settings-change detection — pull the prior snapshot once so the
    // diff and the upsert run side-by-side. Only meaningful when this
    // refresh succeeded (fetchStatus === 'ok'); error refreshes
    // shouldn't trigger "settings changed" audits.
    let priorSettings: typeof payload.settings = null;
    if (fetchStatus === "ok") {
      const { data: prior } = await supabase
        .schema("resupply")
        .from("patient_integration_snapshots")
        .select("payload")
        .eq("patient_id", patientId)
        .eq("source", source)
        .limit(1)
        .maybeSingle();
      const priorPayload = prior?.payload as unknown as
        | { settings?: typeof payload.settings }
        | null;
      priorSettings = priorPayload?.settings ?? null;
    }

    // UPSERT — there's a unique on (patient_id, source). The
    // IntegrationSnapshot shape doesn't carry an index signature so
    // PostgREST's `Json` type rejects it without a cast.
    const fetchedAtIso = new Date().toISOString();
    const { data: row, error: upsertErr } = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .upsert(
        {
          patient_id: patientId,
          source,
          partner_patient_id: partnerPatientId,
          payload: payload as unknown as Json,
          fetch_status: fetchStatus,
          fetch_error: fetchError,
          fetched_at: fetchedAtIso,
        },
        { onConflict: "patient_id,source" },
      )
      .select(
        "id, source, payload, fetch_status, fetch_error, fetched_at",
      )
      .limit(1)
      .maybeSingle();
    if (upsertErr) throw upsertErr;
    if (!row) {
      logger.warn(
        { patient_id: patientId, source },
        "patient_integration_snapshots upsert returned no row",
      );
      res.status(500).json({ error: "internal_error" });
      return;
    }

    await logAudit({
      action: "patient.integration_snapshot.refreshed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_integration_snapshots",
      targetId: row.id,
      // Envelope: ids + status only. Payload is PHI-adjacent and
      // intentionally excluded.
      metadata: {
        patient_id: patientId,
        snapshot_id: row.id,
        source,
        fetch_status: fetchStatus,
        fetch_error: fetchError,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.integration_snapshot.refreshed audit write failed",
      );
    });

    if (fetchStatus === "error") {
      res.status(502).json({
        error: "fetch_failed",
        fetchError,
        snapshot: snapshotRowToView(row),
      });
      return;
    }

    // Mirror the snapshot's recent nights into the canonical
    // patient_therapy_nights table so the compliance scanner,
    // /shop/me/therapy-summary, and smart-trigger evaluator all
    // see the data without re-querying the partner. Best-effort —
    // the snapshot upsert above is the authoritative success, and
    // a persist failure shouldn't fail the refresh.
    let nightsPersisted = 0;
    if (
      source === "resmed_airview" ||
      source === "philips_care" ||
      source === "health_connect"
    ) {
      try {
        const r = await persistTherapyNights(
          supabase,
          patientId,
          source,
          payload.recentNights,
        );
        nightsPersisted = r.inserted;
      } catch (err) {
        logger.warn(
          { err, patient_id: patientId, source },
          "persistTherapyNights failed",
        );
      }
    }

    // Settings-change audit. Only emit when there's at least one
    // tracked-field change; per-field values are NON-PHI categorical
    // (mode, pressure number, level) so they're safe in metadata.
    const settingsChanges = diffSettings(priorSettings, payload.settings);
    if (settingsChanges.length > 0) {
      await logAudit({
        action: "patient.integration_snapshot.settings_changed",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patient_integration_snapshots",
        targetId: row.id,
        metadata: {
          patient_id: patientId,
          source,
          changes: settingsChanges.map((c) => ({
            field: c.field,
            before: c.before == null ? null : String(c.before),
            after: c.after == null ? null : String(c.after),
          })),
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err },
          "integration_snapshot.settings_changed audit write failed",
        );
      });
    }

    // Auto-link the vendor's device data into equipment_assets so
    // the recall-match query has the serial without a CSR re-keying
    // it. Best-effort; a failure here doesn't fail the refresh.
    let equipmentOutcome: Awaited<
      ReturnType<typeof linkEquipmentFromSnapshot>
    > = { kind: "no_settings" };
    let recallNotificationsQueued = 0;
    if (fetchStatus === "ok") {
      try {
        equipmentOutcome = await linkEquipmentFromSnapshot(
          supabase,
          patientId,
          payload.settings,
        );
        if (
          equipmentOutcome.kind === "inserted" ||
          equipmentOutcome.kind === "matched"
        ) {
          const scan = await scanRecallsForAsset(
            supabase,
            equipmentOutcome.assetId,
          );
          recallNotificationsQueued = scan.notificationsQueued;
          if (scan.notificationsQueued > 0) {
            await logAudit({
              action: "patient.equipment.recall.auto_queued",
              adminEmail: req.adminEmail ?? null,
              adminUserId: req.adminUserId ?? null,
              targetTable: "recall_notifications",
              targetId: equipmentOutcome.assetId,
              metadata: {
                patient_id: patientId,
                source,
                matched_recall_ids: scan.matchedRecallIds,
                queued: scan.notificationsQueued,
              },
              ip: req.ip ?? null,
              userAgent: req.get("user-agent") ?? null,
            }).catch((err) => {
              logger.warn(
                { err },
                "equipment.recall.auto_queued audit write failed",
              );
            });
          }
        }
      } catch (err) {
        logger.warn(
          { err, patient_id: patientId, source },
          "linkEquipmentFromSnapshot / scanRecallsForAsset failed",
        );
      }
    }

    // Re-evaluate smart triggers for this patient now that fresh
    // nights are in. Lets a late-arriving missed-night signal fire
    // a reorder nudge inside the request instead of waiting for the
    // daily evaluator cron.
    let smartTriggerResult: Awaited<
      ReturnType<typeof evaluatePatientSmartTriggers>
    > | null = null;
    if (fetchStatus === "ok" && nightsPersisted > 0) {
      try {
        smartTriggerResult = await evaluatePatientSmartTriggers(patientId, {
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
      } catch (err) {
        logger.warn(
          { err, patient_id: patientId },
          "evaluatePatientSmartTriggers failed (non-fatal)",
        );
      }
    }

    res.json({
      snapshot: snapshotRowToView(row),
      nightsPersisted,
      settingsChanges,
      equipment: equipmentOutcome,
      recallNotificationsQueued,
      smartTriggers: smartTriggerResult,
    });
  },
);

export default router;
