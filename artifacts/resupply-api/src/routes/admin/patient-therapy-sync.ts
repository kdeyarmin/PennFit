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

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

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

    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select(
        "id, night_date, source, usage_minutes, ahi, leak_rate_l_min, pressure_p95_cmh2o",
      )
      .eq("patient_id", patientId)
      .order("night_date", { ascending: false })
      .limit(60);
    if (error) throw error;

    res.json({
      // PostgREST returns numeric columns as strings (preserves
      // precision); the original Drizzle path also returned strings
      // and the route already coerced via Number(). Same here.
      nights: (rows ?? []).map((r) => ({
        id: r.id,
        nightDate: r.night_date,
        source: r.source,
        usageMinutes: r.usage_minutes,
        ahi: r.ahi !== null ? Number(r.ahi) : null,
        leakRateLMin: r.leak_rate_l_min !== null ? Number(r.leak_rate_l_min) : null,
        pressureP95Cmh2o:
          r.pressure_p95_cmh2o !== null ? Number(r.pressure_p95_cmh2o) : null,
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

      // Bulk upsert. The unique (patient, night, source) constraint
      // dedupes re-imports — supabase-js's `.upsert()` supports
      // explicit conflict columns via `onConflict`.
      if (result.nights.length > 0) {
        const rowsToUpsert = result.nights.map((n) => ({
          patient_id: patientId,
          night_date: n.nightDate,
          source,
          source_event_id: n.sourceEventId,
          usage_minutes: n.usageMinutes,
          ahi: n.ahi !== null ? String(n.ahi) : null,
          leak_rate_l_min:
            n.leakRateLMin !== null ? String(n.leakRateLMin) : null,
          pressure_p95_cmh2o:
            n.pressureP95Cmh2o !== null ? String(n.pressureP95Cmh2o) : null,
          updated_at: new Date().toISOString(),
        }));
        const { error: upsertErr } = await supabase
          .schema("resupply")
          .from("patient_therapy_nights")
          .upsert(rowsToUpsert, {
            onConflict: "patient_id,night_date,source",
          });
        if (upsertErr) throw upsertErr;
        imported = rowsToUpsert.length;
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
