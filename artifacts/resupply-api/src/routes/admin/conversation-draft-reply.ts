// POST /admin/conversations/:id/draft-reply — AI-draft the agent's next
// reply (Phase 4, CSR #15). Returns a suggested draft the CSR edits
// before sending through the existing /conversations/:id/reply path —
// this endpoint NEVER sends anything itself.
//
// Degrades soft: when no Anthropic key is configured (or the model
// errors) it returns 200 with `available: false` + a reason, so the
// composer falls back to manual typing rather than showing an error.
//
// PHI posture: message bodies are scrubbed by `redactPiiForOutbound`
// inside the drafter before any text leaves PennPaps. We do NOT send the
// patient's name (the `bytea` name columns need a vetted decode path —
// a generic greeting is fine and the CSR personalizes on edit). The log
// records counts + the soft reason only — never the bodies or the draft.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  draftConversationReply,
  MAX_TURNS,
  type DraftTurn,
} from "../../lib/conversations/draft-reply";

const router: IRouter = Router();

const idParam = z.string().uuid();

router.post(
  "/admin/conversations/:id/draft-reply",
  // Limiter before the auth gate — this triggers a paid model call, so
  // throttle per-admin regardless of permission outcome.
  adminReadRateLimiter,
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_conversation_id" });
      return;
    }
    const conversationId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const convo = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id, channel, status")
      .eq("id", conversationId)
      .maybeSingle();
    if (convo.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: convo.error.message });
      return;
    }
    if (!convo.data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const channel = String((convo.data as { channel?: unknown }).channel ?? "");

    // Most recent window of messages, oldest→newest for the transcript.
    const msgs = await supabase
      .schema("resupply")
      .from("messages")
      .select("direction, sender_role, body, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(MAX_TURNS);
    if (msgs.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: msgs.error.message });
      return;
    }
    const turns: DraftTurn[] = (
      (msgs.data ?? []) as Array<Record<string, unknown>>
    )
      .map((m) => ({
        direction: String(m.direction ?? ""),
        sender_role: String(m.sender_role ?? ""),
        body: String(m.body ?? ""),
      }))
      .reverse();

    const result = await draftConversationReply({ channel, turns });

    // Counts + soft reason only — never the draft or any body.
    req.log?.info(
      {
        event: "admin.conversations.draft_reply",
        available: result.ok,
        reason: result.ok ? "ok" : result.reason,
        redactions: result.redactions,
        turns: turns.length,
        adminEmail: req.adminEmail,
      },
      "admin.conversations.draft_reply",
    );

    if (result.ok) {
      res.json({
        available: true,
        draft: result.draft,
        provider: result.provider,
        redactions: result.redactions,
      });
      return;
    }
    res.json({
      available: false,
      reason: result.reason,
      redactions: result.redactions,
    });
  },
);

export default router;
