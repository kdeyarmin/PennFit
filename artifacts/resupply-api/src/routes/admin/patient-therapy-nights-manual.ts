// /admin/patients/:id/therapy-nights — admin manual entry of a
// therapy night when the partner integration isn't available
// (e.g. SD-card upload, patient-provided phone screenshot).
//
//   POST /admin/patients/:id/therapy-nights
//        Body: { nightDate, usageMinutes, ahi?, leakLMin?, maskSealPct?,
//                centralApneas?, obstructiveApneas? }
//        Inserts a row with source='manual'.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
    usageMinutes: z.number().int().min(0).max(24 * 60),
    ahi: z.number().min(0).max(150).optional(),
    leakRateLMin: z.number().min(0).max(120).optional(),
    pressureP95Cmh2o: z.number().min(0).max(30).optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/therapy-nights",
  // Manual entry of a therapy night — recorded as source='manual'.
  // Scoped to `patients.update`; tightens out `fulfillment` and
  // `compliance_officer` (neither has a workflow that authors
  // clinical data; compliance officer audits but does not enter).
  requirePermission("patients.update"),
  adminRateLimit({
    name: "patient_therapy_nights.manual",
    preset: "mutation",
  }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .upsert(
        {
          patient_id: idParse.data,
          night_date: parsed.data.nightDate,
          source: "manual",
          source_event_id: `manual:${req.adminUserId ?? "unknown"}:${parsed.data.nightDate}`,
          usage_minutes: parsed.data.usageMinutes,
          ahi:
            parsed.data.ahi != null ? String(parsed.data.ahi) : null,
          leak_rate_l_min:
            parsed.data.leakRateLMin != null
              ? String(parsed.data.leakRateLMin)
              : null,
          pressure_p95_cmh2o:
            parsed.data.pressureP95Cmh2o != null
              ? String(parsed.data.pressureP95Cmh2o)
              : null,
        },
        { onConflict: "patient_id,night_date,source" },
      )
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "therapy.night.manual.upsert",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_therapy_nights",
      targetId: data.id,
      metadata: {
        // Aggregate values are PHI in context — keep the envelope
        // minimal: just date + source. The numeric body lives only
        // in the row itself.
        night_date: parsed.data.nightDate,
        source: "manual",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "therapy.night.manual.upsert audit failed");
    });
    res.status(201).json({ id: data.id });
  },
);

export default router;
