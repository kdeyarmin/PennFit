// /admin/conversations/:id/{snooze,tags,claim} — Wave 1 conversation
// triage adds (snooze + tags + claim).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const TAG = /^[a-z0-9_-]{1,32}$/;

const snoozeBody = z
  .object({
    snoozedUntil: z.string().datetime().nullable(),
  })
  .strict();

const tagsBody = z
  .object({
    tags: z.array(z.string().regex(TAG)).max(20),
  })
  .strict();

router.patch(
  "/admin/conversations/:id/snooze",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "conversation_triage.snooze", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = snoozeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({
        snoozed_until: parsed.data.snoozedUntil,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

router.patch(
  "/admin/conversations/:id/tags",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "conversation_triage.tags", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = tagsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const tags = Array.from(
      new Set(parsed.data.tags.map((t) => t.trim().toLowerCase())),
    );
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({ tags, updated_at: new Date().toISOString() })
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, tags });
  },
);

// POST .../claim — current CSR stamps themselves as the assignee
// when the conversation is unassigned. Refuses when someone else
// already holds it (returns 409 already_assigned). Audit-logs the
// claim so supervisors can see who self-assigned what.
router.post(
  "/admin/conversations/:id/claim",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "conversation_triage.claim", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const adminUserId = req.adminUserId;
    if (!adminUserId) {
      res.status(500).json({ error: "admin_user_id_missing" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: claimed, error } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({
        assigned_admin_user_id: adminUserId,
        assigned_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", params.data.id)
      .is("assigned_admin_user_id", null)
      .select("id");
    if (error) throw error;
    if (!claimed || claimed.length === 0) {
      // Either the row doesn't exist OR someone else has it. We
      // disambiguate with a follow-up read so the SPA can render
      // the appropriate banner.
      const { data: existing } = await supabase
        .schema("resupply")
        .from("conversations")
        .select("assigned_admin_user_id")
        .eq("id", params.data.id)
        .limit(1)
        .maybeSingle();
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(409).json({
        error: "already_assigned",
        assignedAdminUserId: existing.assigned_admin_user_id,
      });
      return;
    }

    await logAudit({
      action: "conversation.claimed",
      adminEmail: req.adminEmail ?? null,
      adminUserId,
      targetTable: "conversations",
      targetId: params.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "conversation.claimed audit failed");
    });

    res.json({ ok: true });
  },
);

// GET /admin/conversations/:id/transcript.csv — flat CSV of every
// message in a conversation. Useful for surveyor exports, legal
// requests, and patient transcript requests.
router.get(
  "/admin/conversations/:id/transcript.csv",
  requirePermission("audit.export"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: convo } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id, channel")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!convo) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { data: messages, error } = await supabase
      .schema("resupply")
      .from("messages")
      .select(
        "id, direction, sender_role, body, delivery_status, delivery_error, sent_at, created_at",
      )
      .eq("conversation_id", params.data.id)
      .order("created_at", { ascending: true })
      .limit(10_000);
    if (error) throw error;

    const filename = `conversation-${params.data.id.slice(0, 8)}-transcript.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.write(
      [
        "message_id",
        "direction",
        "sender_role",
        "delivery_status",
        "delivery_error",
        "sent_at",
        "created_at",
        "body",
      ].join(",") + "\n",
    );
    for (const m of messages ?? []) {
      res.write(
        [
          m.id,
          m.direction,
          m.sender_role,
          m.delivery_status ?? "",
          m.delivery_error ?? "",
          m.sent_at ?? "",
          m.created_at,
          m.body ?? "",
        ]
          .map(transcriptCsvCell)
          .join(",") + "\n",
      );
    }
    res.end();
  },
);

// Delegate to the shared safe-csv-cell helper so the transcript
// export gets formula-injection neutralisation along with the
// RFC 4180 quoting. The body column is raw patient text — a reply
// like `=HYPERLINK(...)` would otherwise run in a CSR's Excel.
function transcriptCsvCell(value: unknown): string {
  return safeCsvCell(value);
}

export default router;
