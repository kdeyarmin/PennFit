// /admin/audit-log/archive — visibility + admin-only destruction of
// audit rows past the HIPAA 6-year retention floor (flagged nightly
// by the audit-log-archive-sweep worker).
//
//   GET  /admin/audit-log/archive       — list flagged rows
//   POST /admin/audit-log/archive/destroy
//        body: { confirm: "DESTROY", olderThan?: ISO }
//
// Destruction wipes flagged rows whose occurred_at is older than
// the supplied cutoff (default: anything currently flagged). Admin-
// only — destruction is a one-way action; the supervisor role can
// review but not pull the trigger.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/audit-log/archive",
  // Read-only view of archived rows past the HIPAA retention floor.
  // `audit.read` is held by admin / supervisor / compliance_officer
  // / agent — correct surveyors-and-ops envelope. Removes csr /
  // fitter / fulfillment (no compliance workflow on this surface).
  requirePermission("audit.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    // First 500 archived rows for review; full export still goes
    // through /audit/export.csv with the same retention envelope.
    const { data, error } = await supabase
      .schema("resupply")
      .from("audit_log")
      .select(
        "id, action, operator_email, target_table, target_id, occurred_at, archived_at",
      )
      .not("archived_at", "is", null)
      .order("occurred_at", { ascending: true })
      .limit(500);
    if (error) throw error;
    // Count pending destruction (anyone flagged but not yet
    // deleted, which is all of them today since destroy is
    // immediate). Surveyors ask for "how many rows are eligible
    // for destruction" up front.
    const { count } = await supabase
      .schema("resupply")
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .not("archived_at", "is", null);
    res.json({
      total: count ?? 0,
      sample: (data ?? []).map((r) => ({
        id: r.id,
        action: r.action,
        operatorEmail: r.operator_email,
        targetTable: r.target_table,
        targetId: r.target_id,
        occurredAt: r.occurred_at,
        archivedAt: r.archived_at,
      })),
    });
  },
);

router.post(
  "/admin/audit-log/archive/destroy",
  requireAdminOnly,
  async (req, res) => {
    const parsed = z
      .object({
        confirm: z.literal("DESTROY"),
        olderThan: z.string().datetime().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        message:
          'Body must include {"confirm":"DESTROY"} — a deliberate confirmation guard.',
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const cutoff =
      parsed.data.olderThan ?? new Date().toISOString();
    const { data: deleted, error } = await supabase
      .schema("resupply")
      .from("audit_log")
      .delete()
      .not("archived_at", "is", null)
      .lte("occurred_at", cutoff)
      .select("id");
    if (error) throw error;
    const count = (deleted ?? []).length;

    await logAudit({
      action: "audit_log.archive.destroyed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "audit_log",
      targetId: null,
      metadata: { destroyed_count: count, cutoff },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "audit_log.archive.destroyed audit failed",
      );
    });

    res.json({ ok: true, destroyed: count });
  },
);

export default router;
