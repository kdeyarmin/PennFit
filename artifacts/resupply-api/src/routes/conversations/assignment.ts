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
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { conversations, getDbPool } from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";

import { logger } from "../../lib/logger";
import { requireAdmin, requireAdminOnly } from "../../middlewares/requireAdmin";

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
  const db = drizzle(getDbPool());

  const rows = await db
    .select({
      id: conversations.id,
      assignedAdminUserId: conversations.assignedAdminUserId,
      status: conversations.status,
      priority: conversations.priority,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  if (
    row.assignedAdminUserId &&
    row.assignedAdminUserId !== adminId &&
    !force
  ) {
    res.status(409).json({
      error: "already_assigned",
      message:
        "Another team member already claimed this conversation. Pass ?force=1 to take over.",
      assignedTo: row.assignedAdminUserId,
    });
    return;
  }
  const now = new Date();
  const priority = (row.priority as ConversationPriority) ?? "normal";
  const slaDueAt =
    row.status === "awaiting_admin"
      ? computeSlaDueAt(priority, row.status, now)
      : undefined;
  const updates: Partial<typeof conversations.$inferInsert> = {
    assignedAdminUserId: adminId,
    assignedAt: now,
    updatedAt: now,
  };
  if (slaDueAt !== undefined) updates.slaDueAt = slaDueAt;
  await db.update(conversations).set(updates).where(eq(conversations.id, id));
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
  const db = drizzle(getDbPool());
  const rows = await db
    .select({ assignedAdminUserId: conversations.assignedAdminUserId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  if (
    row.assignedAdminUserId &&
    row.assignedAdminUserId !== adminId &&
    adminRole !== "admin"
  ) {
    res.status(403).json({
      error: "not_yours",
      message:
        "Only the assignee or a full admin can release someone else's claim.",
    });
    return;
  }
  await db
    .update(conversations)
    .set({
      assignedAdminUserId: null,
      assignedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, id));
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
  const db = drizzle(getDbPool());
  const updated = await db
    .update(conversations)
    .set({
      assignedAdminUserId: parsed.data.userId,
      assignedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id });
  if (updated.length === 0) {
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
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      status: conversations.status,
      assignedAt: conversations.assignedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  // SLA recomputation baseline: assignedAt if available (so urgent
  // promotions don't unfairly extend an already-late thread), else now().
  const baseline = row.assignedAt ?? new Date();
  const slaDueAt = computeSlaDueAt(parsed.data.priority, row.status, baseline);
  await db
    .update(conversations)
    .set({
      priority: parsed.data.priority,
      slaDueAt: slaDueAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, id));
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
  const db = drizzle(getDbPool());
  // Bumps priority to high if currently low/normal — escalation should
  // pull this up the queue. Don't downgrade urgent.
  const updated = await db
    .update(conversations)
    .set({
      escalatedAt: new Date(),
      escalatedTo: parsed.data.escalateTo ?? null,
      escalationReason: parsed.data.reason,
      priority: sql`CASE WHEN priority IN ('low','normal') THEN 'high' ELSE priority END`,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id });
  if (updated.length === 0) {
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
    const db = drizzle(getDbPool());
    const updated = await db
      .update(conversations)
      .set({
        escalatedAt: null,
        escalatedTo: null,
        escalationReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, id)))
      .returning({ id: conversations.id });
    if (updated.length === 0) {
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
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      status: conversations.status,
      channel: conversations.channel,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  const row = rows[0];
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

  await db
    .update(conversations)
    .set({
      status: nextStatus,
      // SLA only applies to active states. Reopen → recompute; close
      // → null out (the priority + assignment columns survive in
      // case the thread is reopened).
      slaDueAt:
        nextStatus === "closed"
          ? null
          : computeSlaDueAt("normal", nextStatus, new Date()),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, id));

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
