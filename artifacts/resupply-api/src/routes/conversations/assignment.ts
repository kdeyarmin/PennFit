// Conversation assignment, priority, SLA, and escalation endpoints.
//
//   POST /conversations/:id/claim       — assign to caller; refuse if
//                                          already claimed by someone else
//                                          unless `?force=1`
//   POST /conversations/:id/release     — unassign (own claim or admin
//                                          override)
//   POST /conversations/:id/assign      — assign to a specific admin/agent
//                                          user id (admin-only)
//   POST /conversations/:id/priority    — set priority + recompute SLA
//   POST /conversations/:id/escalate    — flag for supervisor with note
//   POST /conversations/:id/de-escalate — clear escalation flag
//
// SLA computation lives in computeSlaDueAt() — keep it here so route
// handlers and the migration policy stay aligned.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";

import { logger } from "../../lib/logger";
import { requireAdmin, requireAdminOnly } from "../../middlewares/requireAdmin";

type ConversationUpdate =
  Database["resupply"]["Tables"]["conversations"]["Update"];

const router: IRouter = Router();

export type ConversationPriority = "low" | "normal" | "high" | "urgent";

// Hours until SLA breach, by priority. SLAs apply ONLY to the
// awaiting_admin status (we owe the patient a response). awaiting_patient
// SLAs would be customer-side and are out of scope. closed conversations
// have no SLA.
const SLA_HOURS: Record<ConversationPriority, number> = {
  urgent: 1,
  high: 4,
  normal: 8,
  low: 24,
};

export function computeSlaDueAt(
  priority: ConversationPriority,
  status: string,
  baseline: Date,
): Date | null {
  if (status !== "awaiting_admin" && status !== "open") return null;
  const hours = SLA_HOURS[priority] ?? SLA_HOURS.normal;
  return new Date(baseline.getTime() + hours * 60 * 60 * 1000);
}

const PRIORITY_VALUES: ConversationPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];

const PRIORITY_RANK: Record<ConversationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

function parseId(req: import("express").Request): string | null {
  const id = req.params.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

router.post("/conversations/:id/claim", requireAdmin, async (req, res) => {
  const id = parseId(req);
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const force = req.query.force === "1";
  const adminId = req.adminUserId!;
  const supabase = getSupabaseServiceRoleClient();

  const { data: row, error: lookupErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id, assigned_admin_user_id, status, priority")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  if (
    row.assigned_admin_user_id &&
    row.assigned_admin_user_id !== adminId &&
    !force
  ) {
    res.status(409).json({
      error: "already_assigned",
      message:
        "Another team member already claimed this conversation. Pass ?force=1 to take over.",
      assignedTo: row.assigned_admin_user_id,
    });
    return;
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const priority = (row.priority as ConversationPriority) ?? "normal";
  const slaDueAt =
    row.status === "awaiting_admin"
      ? computeSlaDueAt(priority, row.status, now)
      : undefined;
  const updates: ConversationUpdate = {
    assigned_admin_user_id: adminId,
    assigned_at: nowIso,
    updated_at: nowIso,
  };
  if (slaDueAt !== undefined) updates.sla_due_at = slaDueAt?.toISOString() ?? null;
  const { error: updateErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update(updates)
    .eq("id", id);
  if (updateErr) throw updateErr;
  res.json({
    ok: true,
    assignedTo: adminId,
    slaDueAt: slaDueAt?.toISOString() ?? null,
  });
});

router.post("/conversations/:id/release", requireAdmin, async (req, res) => {
  const id = parseId(req);
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const adminId = req.adminUserId!;
  const adminRole = req.adminRole;
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error: lookupErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("assigned_admin_user_id")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  if (
    row.assigned_admin_user_id &&
    row.assigned_admin_user_id !== adminId &&
    adminRole !== "admin"
  ) {
    res.status(403).json({
      error: "not_yours",
      message:
        "Only the assignee or a full admin can release someone else's claim.",
    });
    return;
  }
  const { error: updateErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({
      assigned_admin_user_id: null,
      assigned_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateErr) throw updateErr;
  res.json({ ok: true });
});

const assignBody = z.object({ userId: z.string().min(1) }).strict();

router.post("/conversations/:id/assign", requireAdminOnly, async (req, res) => {
  const id = parseId(req);
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const parsed = assignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({
      assigned_admin_user_id: parsed.data.userId,
      assigned_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", id)
    .select("id");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  res.json({ ok: true });
});

const priorityBody = z
  .object({
    priority: z.enum(
      PRIORITY_VALUES as [ConversationPriority, ...ConversationPriority[]],
    ),
  })
  .strict();

router.post("/conversations/:id/priority", requireAdmin, async (req, res) => {
  const id = parseId(req);
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const parsed = priorityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error: lookupErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("status, assigned_at")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  // SLA recomputation baseline: assignedAt if available (so urgent
  // promotions don't unfairly extend an already-late thread), else now().
  const baseline = row.assigned_at ? new Date(row.assigned_at) : new Date();
  const slaDueAt = computeSlaDueAt(parsed.data.priority, row.status, baseline);
  const { error: updateErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({
      priority: parsed.data.priority,
      sla_due_at: slaDueAt?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateErr) throw updateErr;
  res.json({ ok: true, slaDueAt: slaDueAt?.toISOString() ?? null });
});

const escalateBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
    escalateTo: z.string().trim().min(1).max(120).optional().nullable(),
  })
  .strict();

router.post("/conversations/:id/escalate", requireAdmin, async (req, res) => {
  const id = parseId(req);
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const parsed = escalateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  // The original used a raw `CASE WHEN priority IN ('low','normal') THEN
  // 'high' ELSE priority END` to bump priority without downgrading
  // urgent threads. PostgREST has no SQL CASE, so we read-then-write:
  // fetch the current priority, decide JS-side, then update.
  const { data: row, error: lookupErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("priority")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  const currentPriority = (row.priority as ConversationPriority) ?? "normal";
  const nextPriority: ConversationPriority =
    PRIORITY_RANK[currentPriority] < PRIORITY_RANK.high
      ? "high"
      : currentPriority;
  const nowIso = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({
      escalated_at: nowIso,
      escalated_to: parsed.data.escalateTo ?? null,
      escalation_reason: parsed.data.reason,
      priority: nextPriority,
      updated_at: nowIso,
    })
    .eq("id", id)
    .select("id");
  if (updateErr) throw updateErr;
  if (!updated || updated.length === 0) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  res.json({ ok: true });
});

router.post(
  "/conversations/:id/de-escalate",
  requireAdminOnly,
  async (req, res) => {
    const id = parseId(req);
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({
        escalated_at: null,
        escalated_to: null,
        escalation_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

// =====================================================================
// POST /conversations/:id/status — flip a conversation's status.
//
// Restricted to in_app channel for v1: SMS / email / voice flows have
// their own status semantics (e.g. closed by an email-click confirmation,
// or by replyInConversation flipping awaiting_admin → awaiting_patient).
// Mixing CSR-driven manual status changes into those flows would race
// with the dispatcher; in-app threads have no dispatcher to race with.
//
// Allowed transitions:
//   open / awaiting_* → closed              (CSR marks resolved)
//   closed           → awaiting_admin        (CSR reopens; ball is theirs)
//   open / awaiting_* ↔ awaiting_admin / awaiting_patient (manual override)
//
// The endpoint accepts any of the four enum values; the route doesn't
// enforce specific transitions because the most common manual override
// is "I closed this by mistake, reopen as awaiting_admin so my SLA
// kicks back in".
//
// Audit: writes a `messaging.conversation.status_change` row with the
// before + after status. No PHI in the metadata envelope.
// =====================================================================

const statusBody = z
  .object({
    status: z.enum(["open", "awaiting_patient", "awaiting_admin", "closed"]),
  })
  .strict();

router.post("/conversations/:id/status", requireAdmin, async (req, res) => {
  const id = parseId(req);
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const parsed = statusBody.safeParse(req.body);
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
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error: lookupErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("status, channel")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  if (row.channel !== "in_app") {
    // Patient-flow channels manage status via the dispatcher
    // (replyInConversation, email-click confirm, etc.). Manual
    // CSR status writes there would race with those state machines.
    res.status(409).json({
      error: "wrong_channel",
      message:
        "Manual status changes are only supported on in_app conversations. " +
        "SMS / email / voice flows manage their own status.",
    });
    return;
  }

  const nextStatus = parsed.data.status;
  if (row.status === nextStatus) {
    // Idempotent: no-op when already in the requested state. Don't
    // burn an audit row.
    res.json({ ok: true, status: nextStatus, changed: false });
    return;
  }

  const { error: updateErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({
      status: nextStatus,
      // SLA only applies to active states. Reopen → recompute; close
      // → null out (the priority + assignment columns survive in
      // case the thread is reopened).
      sla_due_at:
        nextStatus === "closed"
          ? null
          : computeSlaDueAt("normal", nextStatus, new Date())?.toISOString() ??
            null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateErr) throw updateErr;

  // Audit envelope: structural only.
  await logAudit({
    action: "messaging.conversation.status_change",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "conversations",
    targetId: id,
    metadata: {
      channel: row.channel,
      from_status: row.status,
      to_status: nextStatus,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn(
      { err, conversation_id: id },
      "messaging.conversation.status_change audit write failed",
    );
  });

  res.json({ ok: true, status: nextStatus, changed: true });
});

export default router;
