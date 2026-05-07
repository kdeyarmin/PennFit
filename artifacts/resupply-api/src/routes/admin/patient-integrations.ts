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

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patients,
  patientIntegrationSnapshots,
  patientTherapyLinks,
} from "@workspace/resupply-db";
import {
  INTEGRATION_SOURCES,
  integrationSnapshotSchema,
  type AdapterAvailability,
  type IntegrationSnapshot,
  type IntegrationSource,
} from "@workspace/resupply-integrations";

import { getIntegrationAdapters } from "../../lib/integrations/registry";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.string().uuid();
const refreshBody = z
  .object({
    source: z.enum(INTEGRATION_SOURCES),
  })
  .strict();

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

function snapshotRowToView(row: {
  id: string;
  payload: unknown;
  fetchStatus: string;
  fetchError: string | null;
  fetchedAt: Date;
}): UnifiedSourceView["snapshot"] {
  // Re-validate at the boundary: a payload written by an older
  // adapter version may not match the current schema, in which case
  // we treat it as missing rather than crash the route.
  const parsed = integrationSnapshotSchema.safeParse(row.payload);
  if (!parsed.success) return null;
  return {
    id: row.id,
    payload: parsed.data,
    fetchStatus: row.fetchStatus,
    fetchError: row.fetchError,
    fetchedAt: row.fetchedAt.toISOString(),
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

    const db = drizzle(getDbPool());

    const exists = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, patientId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const [linkRows, snapshotRows] = await Promise.all([
      db
        .select()
        .from(patientTherapyLinks)
        .where(eq(patientTherapyLinks.patientId, patientId))
        .orderBy(
          asc(patientTherapyLinks.status),
          asc(patientTherapyLinks.source),
        ),
      db
        .select()
        .from(patientIntegrationSnapshots)
        .where(eq(patientIntegrationSnapshots.patientId, patientId)),
    ]);

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
              partnerPatientId: link.partnerPatientId,
              deviceSerial: link.deviceSerial,
              status: link.status,
              lastSyncedAt: link.lastSyncedAt
                ? link.lastSyncedAt.toISOString()
                : null,
              lastSyncStatus: link.lastSyncStatus,
              lastSyncError: link.lastSyncError,
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

    const db = drizzle(getDbPool());

    // Look up the active link for this (patient, source). For
    // health_connect there is no link row — the partner-side id
    // is the PennFit patient id (the patient app authenticates
    // as the patient, not via a separate partner account).
    let partnerPatientId: string;
    if (source === "health_connect") {
      const exists = await db
        .select({ id: patients.id })
        .from(patients)
        .where(eq(patients.id, patientId))
        .limit(1);
      if (exists.length === 0) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
      partnerPatientId = patientId;
    } else {
      const linkRows = await db
        .select()
        .from(patientTherapyLinks)
        .where(
          and(
            eq(patientTherapyLinks.patientId, patientId),
            eq(patientTherapyLinks.source, source),
            eq(patientTherapyLinks.status, "active"),
          ),
        )
        .limit(1);
      const link = linkRows[0];
      if (!link) {
        res.status(409).json({
          error: "no_active_link",
          message: `Patient has no active ${source} link. Create one before refreshing.`,
        });
        return;
      }
      partnerPatientId = link.partnerPatientId;
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

    // UPSERT — there's a unique on (patient_id, source).
    const rows = await db
      .insert(patientIntegrationSnapshots)
      .values({
        patientId,
        source,
        partnerPatientId,
        payload,
        fetchStatus,
        fetchError,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          patientIntegrationSnapshots.patientId,
          patientIntegrationSnapshots.source,
        ],
        set: {
          partnerPatientId,
          payload,
          fetchStatus,
          fetchError,
          fetchedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
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

    res.json({ snapshot: snapshotRowToView(row) });
  },
);

export default router;
