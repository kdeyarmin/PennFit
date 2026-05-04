// GET /conversations — paginated conversation queue.
//
// Joins patients to surface firstName + lastName so the queue can
// render a human-readable label without a second round-trip per
// row. Sort key: `lastMessageAt DESC NULLS LAST, createdAt DESC` so
// conversations with fresh activity surface first; brand-new
// conversations (no messages yet) fall back to createdAt order.
//
// Like the patient list, no audit row per page-flip — the
// /conversations/:id detail view is the one that writes the audit
// row, since that is where message bodies cross the wire.

import { Router, type IRouter } from "express";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  conversations,
  getDbPool,
  patients,
  shopCustomers,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const listQuery = z
  .object({
    status: z
      .enum(["open", "awaiting_patient", "awaiting_admin", "closed"])
      .optional(),
    // `in_app` added post-0033: in-account customer-service threads
    // appear in the same inbox as SMS/email/voice and CSRs filter the
    // same way.
    channel: z.enum(["sms", "voice", "email", "in_app"]).optional(),
    patientId: z.string().uuid().optional(),
    /**
     * Inbox view — orthogonal to status. Predefined buckets:
     *   - mine       → assigned to caller, status active
     *   - unassigned → no assignee, status active
     *   - escalated  → escalated_at IS NOT NULL
     *   - breaching  → SLA breach within next 30 minutes (or already)
     */
    view: z.enum(["mine", "unassigned", "escalated", "breaching"]).optional(),
    /** Filter to a specific assignee. Mutually exclusive with view=mine. */
    assignedTo: z.string().min(1).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get("/conversations", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_query",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const {
    status,
    channel,
    patientId,
    view,
    assignedTo,
    priority,
    limit,
    offset,
  } = parsed.data;

  const filters: SQL[] = [];
  if (status) filters.push(eq(conversations.status, status));
  if (channel) filters.push(eq(conversations.channel, channel));
  if (patientId) filters.push(eq(conversations.patientId, patientId));
  if (priority) filters.push(eq(conversations.priority, priority));
  if (view === "mine") {
    if (req.adminUserId) {
      filters.push(eq(conversations.assignedAdminUserId, req.adminUserId));
      filters.push(
        sql`${conversations.status} IN ('open','awaiting_admin','awaiting_patient')`,
      );
    }
  } else if (view === "unassigned") {
    filters.push(isNull(conversations.assignedAdminUserId));
    filters.push(
      sql`${conversations.status} IN ('open','awaiting_admin','awaiting_patient')`,
    );
  } else if (view === "escalated") {
    filters.push(isNotNull(conversations.escalatedAt));
  } else if (view === "breaching") {
    // SLA breach within 30 min OR already breached.
    filters.push(isNotNull(conversations.slaDueAt));
    filters.push(
      sql`${conversations.slaDueAt} <= now() + interval '30 minutes'`,
    );
    filters.push(sql`${conversations.status} IN ('open','awaiting_admin')`);
  } else if (assignedTo) {
    filters.push(eq(conversations.assignedAdminUserId, assignedTo));
  }
  const whereClause = filters.length ? and(...filters) : undefined;

  const db = drizzle(getDbPool());

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(whereClause);

  const rows = await db
    .select({
      id: conversations.id,
      patientId: conversations.patientId,
      patientFirstName: patients.legalFirstName,
      patientLastName: patients.legalLastName,
      // Customer subject (in_app channel only). Both fields nullable
      // for patient-flow conversations — the XOR check guarantees
      // exactly one of (patient_id, customer_id) is set.
      customerId: conversations.customerId,
      customerDisplayName: shopCustomers.displayName,
      customerEmail: shopCustomers.emailLower,
      episodeId: conversations.episodeId,
      channel: conversations.channel,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      assignedAdminUserId: conversations.assignedAdminUserId,
      assignedAt: conversations.assignedAt,
      priority: conversations.priority,
      slaDueAt: conversations.slaDueAt,
      escalatedAt: conversations.escalatedAt,
      escalationReason: conversations.escalationReason,
    })
    .from(conversations)
    .leftJoin(patients, eq(patients.id, conversations.patientId))
    .leftJoin(
      shopCustomers,
      eq(shopCustomers.customerId, conversations.customerId),
    )
    .where(whereClause)
    // Sort: breaching/escalated first (NULLS LAST so non-SLA threads
    // don't push themselves to the top), then last-message recency.
    .orderBy(
      sql`${conversations.escalatedAt} DESC NULLS LAST`,
      sql`${conversations.slaDueAt} ASC NULLS LAST`,
      sql`${conversations.lastMessageAt} DESC NULLS LAST`,
      sql`${conversations.createdAt} DESC`,
    )
    .limit(limit)
    .offset(offset);

  const toIso = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  const toIsoRequired = (v: unknown): string =>
    toIso(v) ?? new Date(0).toISOString();

  res.status(200).json({
    items: rows.map((r) => ({
      id: r.id,
      // Patient/episode subject — null for in_app rows (post-0033).
      patientId: r.patientId,
      patientFirstName: r.patientFirstName ?? "",
      patientLastName: r.patientLastName ?? "",
      episodeId: r.episodeId,
      // Customer subject — null for patient-flow rows. The UI
      // branches on these for in_app channel rendering.
      customerId: r.customerId,
      customerDisplayName: r.customerDisplayName ?? null,
      customerEmail: r.customerEmail ?? null,
      channel: r.channel,
      status: r.status,
      lastMessageAt: toIso(r.lastMessageAt),
      createdAt: toIsoRequired(r.createdAt),
      assignedAdminUserId: r.assignedAdminUserId ?? null,
      assignedAt: toIso(r.assignedAt),
      priority: r.priority ?? "normal",
      slaDueAt: toIso(r.slaDueAt),
      escalatedAt: toIso(r.escalatedAt),
      escalationReason: r.escalationReason ?? null,
    })),
    total: totalRow?.count ?? 0,
    limit,
    offset,
  });
});

export default router;
