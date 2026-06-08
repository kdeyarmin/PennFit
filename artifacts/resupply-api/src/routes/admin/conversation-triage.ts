// /admin/conversations/:id/{snooze,tags,claim} — Wave 1 conversation
// triage adds (snooze + tags + claim).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { resolveSnoozeUntil } from "../../lib/snooze-spec";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const TAG = /^[a-z0-9_-]{1,32}$/;

// Two ways to set a snooze:
//   - `snoozedUntil`: an absolute ISO instant (or null to clear) — the
//     original contract, kept for back-compat.
//   - `snoozeSpec`: a relative/named spec ("1d", "next_business_day", …)
//     resolved server-side via resolveSnoozeUntil. Convenience for CSRs.
// At least one must be present; if both are, `snoozeSpec` wins.
const snoozeBody = z
  .object({
    snoozedUntil: z.string().datetime().nullable().optional(),
    snoozeSpec: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((b) => b.snoozedUntil !== undefined || b.snoozeSpec !== undefined, {
    message: "one of snoozedUntil or snoozeSpec is required",
  });

const tagsBody = z
  .object({
    // Per-tag pattern caps each entry at 32 chars; .max(20) caps
    // the count. The .refine() below caps the SERIALIZED payload at
    // 4 KB so a payload that passes both per-element checks can't
    // still blow up the conversations.tags JSONB column when round-
    // tripped through PostgREST (20 tags * 32 chars + JSON overhead
    // is comfortably under 1 KB; 4 KB leaves headroom for future
    // tag length bumps without re-tuning the cap).
    tags: z
      .array(z.string().regex(TAG))
      .max(20)
      .refine((arr) => JSON.stringify(arr).length <= 4096, {
        message: "tags payload too large",
      }),
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
    // Resolve the effective snooze instant. A spec wins over an absolute
    // timestamp; an unresolvable spec is a 400 rather than a silent no-op.
    let snoozedUntil: string | null;
    if (parsed.data.snoozeSpec !== undefined) {
      const resolved = resolveSnoozeUntil(parsed.data.snoozeSpec);
      if (!resolved.ok) {
        res
          .status(400)
          .json({ error: "invalid_snooze_spec", reason: resolved.reason });
        return;
      }
      snoozedUntil = resolved.untilIso;
    } else {
      snoozedUntil = parsed.data.snoozedUntil ?? null;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({
        snoozed_until: snoozedUntil,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, snoozedUntil });
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
      .select("id, channel, patient_id, customer_id")
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

    // Audit the export BEFORE streaming bytes so a CSR who hits the
    // route still has the access logged even if the connection drops
    // mid-stream. Structural metadata only — no message bodies, no
    // patient identifiers beyond the foreign-key id (PHI-clean per
    // CLAUDE.md "treat every log line as world-readable").
    const messageCount = (messages ?? []).length;
    await logAudit({
      action: "messaging.conversation.transcript_exported",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "conversations",
      targetId: params.data.id,
      metadata: {
        channel: convo.channel,
        patient_id: convo.patient_id ?? null,
        customer_id: convo.customer_id ?? null,
        message_count: messageCount,
        format: "csv",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err, conversation_id: params.data.id },
        "conversation.transcript_exported audit write failed",
      );
    });

    const filename = `conversation-${params.data.id.slice(0, 8)}-transcript.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
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
