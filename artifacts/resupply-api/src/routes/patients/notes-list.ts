// GET /patients/:id/notes — admin notes timeline for one patient.
//
// Returns up to the most recent 50 notes, newest first. The list is
// intentionally not paginated past 50 — notes are an operational
// memory aid, not a long-term archive, and the timeline UI on the
// patient detail page renders inline rather than virtualising.
//
// PHI: the note `body` is stored as plaintext text. The audit row
// records the patient_id and the number of rows returned, never the
// bodies.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.get(
  "/patients/:id/notes",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { id } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Verify the patient exists first so the dashboard's 404 surface
    // for a deleted patient is consistent with /patients/:id.
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("patient_notes")
      .select("id, body, author_email, author_user_id, created_at")
      .eq("patient_id", id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    await logAudit({
      action: "patient.notes.list",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: id,
      metadata: { count: rows?.length ?? 0 },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.notes.list audit write failed");
    });

    res.json({
      notes: (rows ?? []).map((r) => ({
        id: r.id,
        body: r.body ?? "",
        authorEmail: r.author_email,
        authorUserId: r.author_user_id,
        createdAt: r.created_at,
      })),
    });
  },
);

export default router;
