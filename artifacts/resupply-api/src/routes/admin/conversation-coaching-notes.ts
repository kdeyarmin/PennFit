// /admin/conversations/:id/coaching-notes — supervisor-authored
// feedback on a CSR's handling of a conversation.
//
//   GET    /admin/conversations/:id/coaching-notes  — list (anyone
//                                                      who can
//                                                      read the
//                                                      conversation
//                                                      can see)
//   POST   /admin/conversations/:id/coaching-notes  — supervisor-
//                                                      only
//   GET    /admin/team/:userId/coaching-notes        — per-CSR
//                                                      aggregation
//                                                      view
//
// requirePermission("admin_team.manage") gates the write — this is
// effectively a supervisor surface, and the admin role is the only
// one in the rbac catalog that carries that perm today (Phase A
// posture). When a more granular "coach" perm gets added later,
// flip this gate. Reads stay on requireAdmin.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });
const userIdParam = z.object({ userId: z.string().min(1) });

const createBody = z
  .object({
    targetUserId: z.string().min(1).max(64),
    kind: z.enum(["praise", "suggestion", "concern"]),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();

router.get(
  "/admin/conversations/:id/coaching-notes",
  requireAdmin,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("conversation_coaching_notes")
      .select(
        "id, conversation_id, target_user_id, author_user_id, kind, body, created_at, updated_at",
      )
      .eq("conversation_id", params.data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({
      notes: (data ?? []).map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        targetUserId: r.target_user_id,
        authorUserId: r.author_user_id,
        kind: r.kind,
        body: r.body,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.post(
  "/admin/conversations/:id/coaching-notes",
  requirePermission("admin_team.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = createBody.safeParse(req.body);
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
    // Refuse self-coaching — feedback to yourself isn't coaching,
    // and the audit story is clearer when authors and targets are
    // distinct.
    if (parsed.data.targetUserId === req.adminUserId) {
      res.status(409).json({
        error: "self_coaching",
        message:
          "Coaching notes target another team member; use journal/notes for self-reflection.",
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: convo, error: convoErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (convoErr) throw convoErr;
    if (!convo) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("conversation_coaching_notes")
      .insert({
        conversation_id: params.data.id,
        target_user_id: parsed.data.targetUserId,
        author_user_id: req.adminUserId ?? "",
        kind: parsed.data.kind,
        body: parsed.data.body,
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "coaching.note.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "conversation_coaching_notes",
      targetId: row.id,
      metadata: {
        conversation_id: params.data.id,
        target_user_id: parsed.data.targetUserId,
        kind: parsed.data.kind,
        // Body content withheld from audit — coaching is sensitive
        // employment data, surfaced only to authorized eyes via
        // the GET endpoints above.
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "coaching.note.created audit failed");
    });

    res.status(201).json({ id: row.id });
  },
);

router.get(
  "/admin/team/:userId/coaching-notes",
  requireAdmin,
  async (req, res) => {
    const params = userIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // A CSR can read their OWN coaching notes; a supervisor can
    // read anyone's. Anything else is refused.
    if (
      req.adminUserId !== params.data.userId &&
      !["admin", "supervisor"].includes(req.adminGranularRole ?? "")
    ) {
      res.status(403).json({
        error: "permission_denied",
        message:
          "You can only read your own coaching notes unless you're a supervisor.",
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("conversation_coaching_notes")
      .select(
        "id, conversation_id, target_user_id, author_user_id, kind, body, created_at, updated_at",
      )
      .eq("target_user_id", params.data.userId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    const counts = (data ?? []).reduce(
      (acc, r) => {
        acc[r.kind] = (acc[r.kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    res.json({
      counts,
      notes: (data ?? []).map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        authorUserId: r.author_user_id,
        kind: r.kind,
        body: r.body,
        createdAt: r.created_at,
      })),
    });
  },
);

export default router;
