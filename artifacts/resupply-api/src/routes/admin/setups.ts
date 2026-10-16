// /admin/setups — the new-CPAP board.
//
// One row per patient from referral accept or a matched fit request
// until the first-night checklist is done. Stage and blocker are
// computed from the chart, the fit, the signature order, and the
// checklist. The row is not an order.
//
//   GET   /admin/setups          — open rows + morning queue counts
//   POST  /admin/setups          — open a row for a chart by hand
//   PATCH /admin/setups/:id      — claim, release, complete, cancel

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { redactDbErr } from "../../lib/redact-db-err";
import { loadSetupBoard } from "../../lib/setups/board";
import { openPatientSetup } from "../../lib/setups/open-setup";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const openBody = z
  .object({
    patientId: z.string().uuid(),
  })
  .strict();

const patchBody = z
  .object({
    action: z.enum(["claim", "release", "complete", "cancel"]),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid() });

router.get(
  "/admin/setups",
  requirePermission("patients.read"),
  adminRateLimit({ name: "setups.list", preset: "query" }),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    try {
      const board = await loadSetupBoard(orgId, { limit: parsed.data.limit });
      res.json({ rows: board.rows, morning: board.morning });
    } catch (err) {
      logger.warn({ err: redactDbErr(err) }, "setups.list failed");
      res.status(500).json({ error: "setups_unavailable" });
    }
  },
);

router.post(
  "/admin/setups",
  requirePermission("patients.update"),
  adminRateLimit({ name: "setups.open", preset: "mutation" }),
  async (req, res) => {
    const parsed = openBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: patient, error } = await supabase
      .from("patients")
      .select("id")
      .eq("id", parsed.data.patientId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const opened = await openPatientSetup({
      orgId,
      patientId: parsed.data.patientId,
      source: "manual",
      ownerUserId: req.adminUserId ?? null,
      ownerEmail: req.adminEmail ?? null,
    });
    if (!opened) {
      res.status(500).json({ error: "setup_not_opened" });
      return;
    }
    res.status(opened.created ? 201 : 200).json(opened);
  },
);

router.patch(
  "/admin/setups/:id",
  requirePermission("patients.update"),
  adminRateLimit({ name: "setups.patch", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    const body = patchBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();
    const patch =
      body.data.action === "claim"
        ? {
            owner_user_id: req.adminUserId ?? null,
            owner_email: req.adminEmail ?? null,
            updated_at: nowIso,
          }
        : body.data.action === "release"
          ? {
              owner_user_id: null,
              owner_email: null,
              updated_at: nowIso,
            }
          : body.data.action === "complete"
            ? {
                status: "completed" as const,
                completed_at: nowIso,
                updated_at: nowIso,
              }
            : {
                status: "cancelled" as const,
                completed_at: nowIso,
                updated_at: nowIso,
              };
    const { data, error } = await supabase
      .from("patient_setups")
      .update(patch)
      .eq("id", params.data.id)
      .eq("status", "open")
      .select("id, status, owner_email")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      id: data.id,
      status: data.status,
      ownerEmail: data.owner_email,
    });
  },
);

export default router;
