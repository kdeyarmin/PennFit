// /admin/same-or-similar — Medicare HETS Same-or-Similar checks.
//
// HETS 270 with EB qualifier F returns whether another supplier billed
// Medicare for the same HCPCS in the 5-year window. We don't ship the
// full HETS X12 round-trip in this PR (HETS sits behind a separate
// CMS-EDI agreement, distinct from the Office Ally pipeline); instead
// this route persists manually-checked results into the cache + serves
// the cache to the claim builder + preflight engine.
//
// Once the HETS adapter lands, this same route becomes the network
// trigger and the manual path becomes the fallback.
//
//   POST /admin/patients/:id/same-or-similar  — record a check result
//   GET  /admin/patients/:id/same-or-similar  — list cached results

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["medicare_same_or_similar_checks"]["Row"];

const STATUS_VALUES = ["clear", "inactive", "active", "unknown"] as const satisfies readonly Row["status"][];

const idParam = z.object({ id: z.string().uuid() });
const body = z
  .object({
    hcpcsCode: z.string().regex(/^[A-Z]\d{4}$/),
    status: z.enum(STATUS_VALUES),
    lastDispenseOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    /** Free-form notes — typically a screenshot reference or the
     *  HETS portal ticket number when a CSR runs the check manually. */
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

router.get(
  "/admin/patients/:id/same-or-similar",
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("medicare_same_or_similar_checks")
      .select("*")
      .eq("patient_id", parsed.data.id)
      .order("checked_at", { ascending: false })
      .limit(50);
    res.json({ checks: data ?? [] });
  },
);

router.post(
  "/admin/patients/:id/same-or-similar",
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("medicare_same_or_similar_checks")
      .insert({
        patient_id: idParsed.data.id,
        hcpcs_code: b.hcpcsCode.toUpperCase(),
        status: b.status,
        last_dispense_on: b.lastDispenseOn ?? null,
        raw_response_json: b.notes
          ? ({ note: b.notes } as unknown as Database["resupply"]["Tables"]["medicare_same_or_similar_checks"]["Row"]["raw_response_json"])
          : null,
        requested_by_email: req.adminEmail ?? "unknown",
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "same_or_similar.record",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "medicare_same_or_similar_checks",
      targetId: row.id,
      metadata: {
        patient_id: idParsed.data.id,
        hcpcs: b.hcpcsCode,
        status: b.status,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "same_or_similar.record audit write failed");
    });
    res.status(201).json({ id: row.id });
  },
);

export default router;
