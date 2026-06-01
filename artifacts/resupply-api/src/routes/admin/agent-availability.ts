// /admin/agent-availability — CSR availability toggle (migration 0192 /
// Phase 1, CSR #16).
//
//   GET   /admin/agent-availability       — team availability board
//   PATCH /admin/agent-availability/me     — set your own availability
//
// A rep flips themselves to away / do_not_assign when on a break or
// buried in a complex call; the skill-router (auto-assign) then skips
// them. Self-service: gated on requireAdmin (any staff sets their OWN
// status, keyed on the session's admin id — never another rep's).
// Operational, not PHI; logged structurally, no audit row per toggle.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patchSchema = z
  .object({
    availability: z.enum(["available", "away", "do_not_assign"]),
  })
  .strict();

router.get(
  "/admin/agent-availability",
  requireAdmin,
  adminRateLimit({ name: "agent_availability.list", preset: "query" }),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("id, email_lower, display_name, role, availability")
      .eq("status", "active")
      .order("email_lower", { ascending: true });
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    res.json({
      agents: (data ?? []).map((a) => ({
        adminUserId: a.id,
        email: a.email_lower,
        displayName: a.display_name,
        role: a.role,
        availability: a.availability,
      })),
    });
  },
);

router.patch(
  "/admin/agent-availability/me",
  requireAdmin,
  adminRateLimit({ name: "agent_availability.set", preset: "mutation" }),
  async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
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
    const userId = req.adminUserId;
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({
        availability: parsed.data.availability,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select("id, availability")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "admin_not_found" });
      return;
    }

    req.log?.info(
      { adminUserId: userId, availability: parsed.data.availability },
      "admin.agent_availability.set",
    );
    res.json({ adminUserId: data.id, availability: data.availability });
  },
);

export default router;
