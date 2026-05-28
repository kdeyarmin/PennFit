// Skill-based conversation routing (Tier 1 J #4).
//
//   PATCH /admin/team/:id/skills                              — set
//                                                                an
//                                                                admin's
//                                                                skill
//                                                                tags
//   PATCH /admin/conversations/:id/required-skills            — set
//                                                                a
//                                                                conversation's
//                                                                required-
//                                                                skill
//                                                                tags
//   GET   /admin/conversations/:id/assignee-suggestions       — top
//                                                                ranked
//                                                                candidate
//                                                                admins
//
// Both PATCHes are requireAdminOnly (skill catalogs are a policy
// choice, not CSR day-to-day). The suggestions GET + auto-assign
// POST gate on `conversations.manage` — every role that touches the
// inbox needs the routing affordances.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { maybeAutoAssignConversation } from "../../lib/routing/auto-assign";
import { scoreCandidates } from "../../lib/routing/skill-score";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const SKILL = /^[a-z0-9_]{1,40}$/;
const SkillArray = z
  .array(z.string().regex(SKILL))
  .max(20);

const skillsBody = z
  .object({
    skills: SkillArray,
  })
  .strict();

const requiredSkillsBody = z
  .object({
    requiredSkills: SkillArray,
  })
  .strict();

router.patch(
  "/admin/team/:id/skills",
  requireAdminOnly,
  adminRateLimit({ name: "conversation_routing.set_skills", preset: "mutation" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = skillsBody.safeParse(req.body);
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
    // Dedup + lowercase normalization.
    const skills = Array.from(
      new Set(parsed.data.skills.map((s) => s.trim().toLowerCase())),
    );

    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({ skills })
      .eq("id", idCheck.data)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "team.skills.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "admin_users",
      targetId: idCheck.data,
      metadata: { skill_count: skills.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "team.skills.updated audit failed");
    });

    res.json({ ok: true, skills });
  },
);

router.patch(
  "/admin/conversations/:id/required-skills",
  requireAdminOnly,
  adminRateLimit({
    name: "conversation_routing.set_required_skills",
    preset: "mutation",
  }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = requiredSkillsBody.safeParse(req.body);
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
    const required = Array.from(
      new Set(
        parsed.data.requiredSkills.map((s) => s.trim().toLowerCase()),
      ),
    );
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({ required_skills: required })
      .eq("id", idCheck.data)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, requiredSkills: required });
  },
);

router.get(
  "/admin/conversations/:id/assignee-suggestions",
  // Read-only suggestion ranking used by the in-conversation
  // "Assign to…" picker. CSR-tier (`conversations.manage`) since
  // any role that handles the inbox needs the suggestion list to
  // route effectively.
  requirePermission("conversations.manage"),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const { data: convo, error: convoErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id, required_skills")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (convoErr) throw convoErr;
    if (!convo) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Active staff candidates.
    const { data: admins, error: adminErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("id, display_name, email_lower, role, skills")
      .eq("status", "active");
    if (adminErr) throw adminErr;
    const adminList = admins ?? [];
    if (adminList.length === 0) {
      res.json({ candidates: [] });
      return;
    }
    const adminIds = adminList.map((a) => a.id);

    // Open-queue depth per admin for load-balancing.
    const { data: openConvos, error: openErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("assigned_admin_user_id")
      .in("assigned_admin_user_id", adminIds)
      .in("status", ["open", "awaiting_admin", "awaiting_patient"]);
    if (openErr) throw openErr;
    const queueSize = new Map<string, number>();
    for (const r of openConvos ?? []) {
      const id = r.assigned_admin_user_id;
      if (!id) continue;
      queueSize.set(id, (queueSize.get(id) ?? 0) + 1);
    }

    const requiredSkills = Array.isArray(convo.required_skills)
      ? (convo.required_skills as string[])
      : [];

    const scored = scoreCandidates({
      requiredSkills,
      candidates: adminList.map((a) => ({
        adminUserId: a.id,
        skills: Array.isArray(a.skills) ? (a.skills as string[]) : [],
        openQueueSize: queueSize.get(a.id) ?? 0,
      })),
    });

    // Limit to top 10 and decorate with the display fields.
    const adminById = new Map(adminList.map((a) => [a.id, a] as const));
    const candidates = scored.slice(0, 10).map((c) => {
      const a = adminById.get(c.adminUserId);
      return {
        adminUserId: c.adminUserId,
        displayName: a?.display_name ?? null,
        email: a?.email_lower ?? null,
        role: a?.role ?? null,
        skills: c.skills,
        matchedSkillCount: c.matchedSkillCount,
        coversAll: c.coversAll,
        openQueueSize: c.openQueueSize,
      };
    });

    res.json({ requiredSkills, candidates });
  },
);

// ────────────────────────────────────────────────────────────────
// POST /admin/conversations/:id/auto-assign — pick the top-ranked
// candidate from scoreCandidates() and stamp the conversation.
// Refuses to overwrite an existing assignment (use a manual
// re-assign for that). Returns a discriminated outcome so the SPA
// can render the appropriate banner.
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/conversations/:id/auto-assign",
  // Auto-assign action — same scope as the suggestions GET above
  // (it's the action the suggestions feed).
  requirePermission("conversations.manage"),
  adminRateLimit({
    name: "conversation_routing.auto_assign",
    preset: "mutation",
  }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const result = await maybeAutoAssignConversation(supabase, idCheck.data);

    if (result.assigned) {
      await logAudit({
        action: "conversation.auto_assigned",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "conversations",
        targetId: idCheck.data,
        metadata: {
          assignee_user_id: result.adminUserId,
          matched_skill_count: result.matchedSkillCount,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "conversation.auto_assigned audit failed");
      });
    }
    // Translate the non-assigned outcomes to 409 so the SPA can
    // branch on status. "conversation_not_found" stays a 404.
    if (!result.assigned) {
      if (result.reason === "conversation_not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(409).json({
        error: result.reason,
      });
      return;
    }
    res.json(result);
  },
);

export default router;
