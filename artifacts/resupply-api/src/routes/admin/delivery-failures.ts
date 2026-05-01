// /admin/delivery-failures — webhook delivery error triage queue.
//
// Surfaces recent message-send failures across all three channels
// (SMS, email, voice) plus delivery-failure-shaped audit events. Ops
// uses this to spot phone numbers that are bouncing, email addresses
// that are landing in spam, etc. Sorted newest first.
//
// Two source streams unioned in the response:
//   1. messages.delivery_status IN ('failed','undelivered','bounced',
//      'dropped') — per-message terminal failures from the SMS / email
//      status webhooks.
//   2. audit_log rows where action LIKE '%.delivery.%' OR action LIKE
//      '%.failed' — system-level errors (e.g. webhook signature
//      verification failures, bulk-send aborts).
//
// PHI: message bodies are NOT surfaced on this view — operators
// triaging deliverability don't need the content; they need WHERE it
// failed and the error code. Patient name + ID are surfaced (already
// permitted in the rest of the admin console).

import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  conversations,
  getDbPool,
  messages,
  patients,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const FAILURE_STATUSES = [
  "failed",
  "undelivered",
  "bounced",
  "dropped",
  "rejected",
  "spam_report",
] as const;

const DEFAULT_DAYS_BACK = 14;
const MAX_ROWS = 200;

router.get("/admin/delivery-failures", requireAdmin, async (req, res) => {
  const sinceDays = Math.min(
    Math.max(1, Number(req.query.sinceDays ?? DEFAULT_DAYS_BACK)),
    90,
  );
  const since = new Date(Date.now() - sinceDays * 86400_000);

  const db = drizzle(getDbPool());

  // Per-message failures. Joined to conversations + patients so the
  // operator can see who it was for and click through to the thread.
  const messageRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      direction: messages.direction,
      senderRole: messages.senderRole,
      deliveryStatus: messages.deliveryStatus,
      deliveryError: messages.deliveryError,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
      channel: conversations.channel,
      patientId: conversations.patientId,
      patientFirstName: patients.legalFirstName,
      patientLastName: patients.legalLastName,
    })
    .from(messages)
    .leftJoin(conversations, eq(messages.conversationId, conversations.id))
    .leftJoin(patients, eq(patients.id, conversations.patientId))
    .where(
      and(
        sql`${messages.deliveryStatus} IN ('failed','undelivered','bounced','dropped','rejected','spam_report')`,
        gte(messages.createdAt, since),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(MAX_ROWS);

  // System-level failure events from the audit log. We use raw SQL
  // here (rather than a Drizzle import of audit_log) because the
  // resupply-audit lib is the source of truth for that table — we
  // read but never join to it from outside the lib.
  const auditRows = await db.execute<{
    id: string;
    created_at: Date;
    action: string;
    target_table: string | null;
    target_id: string | null;
    actor_email: string | null;
    metadata: Record<string, unknown> | null;
  }>(sql`
    SELECT id, created_at, action, target_table, target_id, actor_email, metadata
    FROM resupply.audit_log
    WHERE created_at >= ${since}
      AND (
        action LIKE '%.delivery.%'
        OR action LIKE '%.failed'
        OR action LIKE '%.bounced'
        OR action LIKE '%.error'
      )
    ORDER BY created_at DESC
    LIMIT ${MAX_ROWS}
  `);

  const messageEvents = messageRows.map((r) => ({
    kind: "message" as const,
    id: r.id,
    occurredAt: (r.createdAt instanceof Date
      ? r.createdAt
      : new Date(String(r.createdAt))
    ).toISOString(),
    channel: r.channel,
    direction: r.direction,
    senderRole: r.senderRole,
    deliveryStatus: r.deliveryStatus,
    deliveryError: r.deliveryError,
    conversationId: r.conversationId,
    patientId: r.patientId,
    patientName:
      [r.patientFirstName, r.patientLastName].filter(Boolean).join(" ").trim() ||
      null,
  }));

  const auditEvents = (auditRows.rows ?? []).map((r) => ({
    kind: "audit" as const,
    id: r.id,
    occurredAt: (r.created_at instanceof Date
      ? r.created_at
      : new Date(String(r.created_at))
    ).toISOString(),
    action: r.action,
    targetTable: r.target_table,
    targetId: r.target_id,
    actorEmail: r.actor_email,
    metadata: r.metadata ?? null,
  }));

  res.json({
    sinceDays,
    counts: {
      messageFailures: messageEvents.length,
      auditFailures: auditEvents.length,
    },
    failureStatuses: FAILURE_STATUSES,
    messageEvents,
    auditEvents,
  });
});

export default router;
