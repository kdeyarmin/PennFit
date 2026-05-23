// POST /admin/payer-fee-schedules/import-csv
//
// Body: { payerProfileId, csv: "<full csv body>" }
// Returns: { accepted, errors }

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { parseFeeScheduleCsv } from "../../lib/billing/fee-schedule-csv";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    payerProfileId: z.string().uuid(),
    csv: z.string().min(20).max(1024 * 1024),
  })
  .strict();

router.post(
  "/admin/payer-fee-schedules/import-csv",
  requireAdminOnly,
  adminRateLimit({
    name: "payer_fee_schedules.import",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: payer } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("id, display_name")
      .eq("id", parsed.data.payerProfileId)
      .limit(1)
      .maybeSingle();
    if (!payer) {
      res.status(404).json({ error: "payer_profile_not_found" });
      return;
    }
    const { rows, errors } = parseFeeScheduleCsv({
      payerProfileId: payer.id,
      csvBody: parsed.data.csv,
    });
    if (rows.length === 0) {
      res.status(400).json({ accepted: 0, errors });
      return;
    }
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("payer_fee_schedules")
      .insert(rows);
    if (insertErr) {
      logger.warn(
        { err: insertErr.message },
        "payer-fee-schedules.import: bulk insert failed",
      );
      res.status(500).json({
        error: "bulk_insert_failed",
        message: insertErr.message,
      });
      return;
    }
    await logAudit({
      action: "payer_fee_schedule.import_csv",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_fee_schedules",
      targetId: payer.id,
      metadata: {
        payer_profile_id: payer.id,
        accepted: rows.length,
        error_count: errors.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_fee_schedule.import_csv audit write failed");
    });
    res.status(201).json({ accepted: rows.length, errors });
  },
);

export default router;
