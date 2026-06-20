// POST /admin/payer-fee-schedules/import-cms
//
// Import the Medicare CMS DMEPOS fee schedule (the quarterly public-use
// `DMEPOS<YY>_<MON>.csv` grid) into payer_fee_schedules for a payer + state.
// Parses the chosen state's non-rural (or rural) column, then REPLACES any
// prior `cms_published` rows for (payer, effective_from) so a re-import of the
// same quarter is idempotent.
//
// Body: { payerProfileId, state, rural?, effectiveFrom, csv }
// Returns: { accepted, replaced, warnings }
//
// Use for the Medicare DME MAC payer profile; commercial fee schedules still
// use the manual /import-csv path. The CMS national file is ~21 MB, but a
// state-filtered export is small; the body cap below sits above a typical
// single-state file.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { parseCmsDmeposFeeScheduleCsv } from "../../lib/billing/cms-dmepos-fee-schedule";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const INSERT_CHUNK = 1000;

const body = z
  .object({
    payerProfileId: z.string().uuid(),
    state: z
      .string()
      .trim()
      .length(2)
      .transform((s) => s.toUpperCase()),
    rural: z.boolean().optional(),
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
    csv: z
      .string()
      .min(20)
      .max(30 * 1024 * 1024),
  })
  .strict();

router.post(
  "/admin/payer-fee-schedules/import-cms",
  requireAdminOnly,
  adminRateLimit({
    name: "payer_fee_schedules.import_cms",
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const { payerProfileId, state, rural, effectiveFrom, csv } = parsed.data;
    const supabase = getOrgScopedClient(orgId);

    const { data: payer } = await supabase
      .from("payer_profiles")
      .select("id")
      .eq("id", payerProfileId)
      .limit(1)
      .maybeSingle();
    if (!payer) {
      res.status(404).json({ error: "payer_profile_not_found" });
      return;
    }

    const { rows, warnings } = parseCmsDmeposFeeScheduleCsv(csv, {
      state,
      rural,
    });
    if (rows.length === 0) {
      res.status(400).json({ accepted: 0, replaced: 0, warnings });
      return;
    }

    // Idempotent replace: drop the prior CMS import for this payer + quarter.
    const { error: delErr } = await supabase
      .from("payer_fee_schedules")
      .delete()
      .eq("payer_profile_id", payer.id)
      .eq("source", "cms_published")
      .eq("effective_from", effectiveFrom);
    if (delErr) {
      res
        .status(500)
        .json({ error: "replace_failed", message: delErr.message });
      return;
    }

    const note = `CMS DMEPOS ${state}${rural ? " rural" : ""}`;
    const toInsert = rows.map((r) => ({
      payer_profile_id: payer.id,
      hcpcs_code: r.hcpcs,
      modifier: r.modifier,
      allowed_cents: r.allowedCents,
      effective_from: effectiveFrom,
      source: "cms_published" as const,
      notes: note,
    }));

    let accepted = 0;
    for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
      const chunk = toInsert.slice(i, i + INSERT_CHUNK);
      const { error: insErr } = await supabase
        .from("payer_fee_schedules")
        .insert(chunk);
      if (insErr) {
        logger.warn(
          { err: insErr.message, inserted: accepted },
          "cms-fee-schedule.import: chunk insert failed",
        );
        res.status(500).json({
          error: "bulk_insert_failed",
          message: insErr.message,
          accepted,
        });
        return;
      }
      accepted += chunk.length;
    }

    await logAudit({
      action: "payer_fee_schedule.import_cms",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_fee_schedules",
      targetId: payer.id,
      metadata: {
        payer_profile_id: payer.id,
        state,
        rural: Boolean(rural),
        effective_from: effectiveFrom,
        accepted,
        warning_count: warnings.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_fee_schedule.import_cms audit write failed");
    });

    res.status(201).json({ accepted, warnings });
  },
);

export default router;
