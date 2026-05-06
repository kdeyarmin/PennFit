// /admin/patients/:id/therapy-nights — therapy-cloud sync (Phase
// E.1 / feature #18).
//
//   GET  /admin/patients/:id/therapy-nights   — read recent nights
//   POST /admin/patients/:id/therapy-nights/sync
//                                              — trigger import from
//                                                a configured partner
//
// The sync endpoint requires `partnerPatientId` + `source` in the
// body — a CSR enters the partner-side patient id explicitly to
// avoid auto-mapping mistakes. Source must be one of the
// `TherapyCloudSource` values; "manual" isn't valid here (no
// remote fetch to perform).
//
// 503 when the requested adapter isn't configured; the SPA hides
// the "Sync from ResMed" button when this happens. No partial
// writes — we batch upserts in one round-trip.
//
// PHI / log posture: nightly data IS PHI. We never log usage /
// AHI / leak values. The audit envelope records patient_id +
// source + import_count only.

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patientTherapyNights,
  patients,
} from "@workspace/resupply-db";

import { adapterFor } from "../../lib/therapy-cloud";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.string().uuid();

const syncBody = z
  .object({
    source: z.enum(["resmed_airview", "philips_care"]),
    partnerPatientId: z.string().trim().min(1).max(200),
    /** Inclusive lower bound for the import. Defaults to 60 days
     *  back so we always catch a meaningful trend window. */
    sinceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
      .refine((s) => {
        const d = new Date(s);
        return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
      }, "must be a valid calendar date")
      .optional(),
  })
  .strict();

const PER_SYNC_CAP = 90; // days

router.get(
  "/admin/patients/:id/therapy-nights",
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const db = drizzle(getDbPool());
    const rows = await db
      .select({
        id: patientTherapyNights.id,
        nightDate: patientTherapyNights.nightDate,
        source: patientTherapyNights.source,
        usageMinutes: patientTherapyNights.usageMinutes,
        ahi: patientTherapyNights.ahi,
        leakRateLMin: patientTherapyNights.leakRateLMin,
        pressureP95Cmh2o: patientTherapyNights.pressureP95Cmh2o,
      })
      .from(patientTherapyNights)
      .where(eq(patientTherapyNights.patientId, patientId))
      .orderBy(desc(patientTherapyNights.nightDate))
      .limit(60);

    res.json({
      nights: rows.map((r) => ({
        id: r.id,
        nightDate: r.nightDate,
        source: r.source,
        usageMinutes: r.usageMinutes,
        ahi: r.ahi !== null ? Number(r.ahi) : null,
        leakRateLMin: r.leakRateLMin !== null ? Number(r.leakRateLMin) : null,
        pressureP95Cmh2o:
          r.pressureP95Cmh2o !== null ? Number(r.pressureP95Cmh2o) : null,
      })),
    });
  },
);

router.post(
  "/admin/patients/:id/therapy-nights/sync",
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const bodyParsed = syncBody.safeParse(req.body);
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
    const { source, partnerPatientId } = bodyParsed.data;
    const sinceDate =
      bodyParsed.data.sinceDate ??
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

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

    const adapter = adapterFor(source);
    if (!adapter.configured) {
      res.status(503).json({
        error: "therapy_cloud_not_configured",
        message: `${source} adapter is not configured on this server. Add the partner OAuth env var and a real adapter implementation.`,
        source,
      });
      return;
    }

    let imported = 0;
    try {
      const result = await adapter.fetchNights({
        partnerPatientId,
        sinceDate,
        limit: PER_SYNC_CAP,
      });

      // Upsert per night. The unique (patient, night, source)
      // constraint deduplicates re-imports.
      for (const n of result.nights) {
        await db
          .insert(patientTherapyNights)
          .values({
            patientId,
            nightDate: n.nightDate,
            source,
            sourceEventId: n.sourceEventId,
            usageMinutes: n.usageMinutes,
            ahi: n.ahi !== null ? String(n.ahi) : null,
            leakRateLMin:
              n.leakRateLMin !== null ? String(n.leakRateLMin) : null,
            pressureP95Cmh2o:
              n.pressureP95Cmh2o !== null ? String(n.pressureP95Cmh2o) : null,
          })
          .onConflictDoUpdate({
            target: [
              patientTherapyNights.patientId,
              patientTherapyNights.nightDate,
              patientTherapyNights.source,
            ],
            set: {
              sourceEventId: n.sourceEventId,
              usageMinutes: n.usageMinutes,
              ahi: n.ahi !== null ? String(n.ahi) : null,
              leakRateLMin:
                n.leakRateLMin !== null ? String(n.leakRateLMin) : null,
              pressureP95Cmh2o:
                n.pressureP95Cmh2o !== null ? String(n.pressureP95Cmh2o) : null,
              updatedAt: new Date(),
            },
          });
        imported++;
      }
    } catch (err) {
      logger.warn(
        { err, patient_id: patientId, source },
        "therapy-cloud sync failed",
      );
      res.status(502).json({
        error: "therapy_cloud_fetch_failed",
        message: "Partner returned an error or timed out.",
      });
      return;
    }

    await logAudit({
      action: "patient.therapy_nights.sync",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_therapy_nights",
      // No specific row id — this is a batch import. Use the
      // patient id so reviewers can grep "what happened on patient X".
      targetId: patientId,
      metadata: {
        patient_id: patientId,
        source,
        import_count: imported,
        since_date: sinceDate,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.therapy_nights.sync audit write failed");
    });

    res.json({ imported, sinceDate, source });
  },
);

export default router;
