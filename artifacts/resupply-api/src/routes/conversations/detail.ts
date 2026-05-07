// GET /conversations/:id — conversation detail with full message body.
//
// This is the only endpoint that surfaces full message bodies to
// the admin console.
//
// Writes one `conversation.view` audit row with the conversation id
// as target. The metadata records the conversation channel + status
// for context and the size of the message timeline (count, not
// content). PHI does not enter the audit metadata.

import { Router, type IRouter } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  conversations,
  getDbPool,
  messageAttachments,
  messages,
  patients,
  shopCustomers,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.get("/conversations/:id", requireAdmin, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { id } = parsed.data;

  const db = drizzle(getDbPool());

  const headerRows = await db
    .select({
      id: conversations.id,
      patientId: conversations.patientId,
      patientFirstName: patients.legalFirstName,
      patientLastName: patients.legalLastName,
      // Shop-customer subject — null for patient-flow rows, set for
      // in_app rows. Joined nullable so the existing patient-flow
      // queries don't change shape.
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
      escalatedTo: conversations.escalatedTo,
      escalationReason: conversations.escalationReason,
    })
    .from(conversations)
    .leftJoin(patients, eq(patients.id, conversations.patientId))
    .leftJoin(
      shopCustomers,
      eq(shopCustomers.customerId, conversations.customerId),
    )
    .where(eq(conversations.id, id))
    .limit(1);

  const header = headerRows[0];
  if (!header) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const messageRows = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      senderRole: messages.senderRole,
      body: messages.body,
      deliveryStatus: messages.deliveryStatus,
      sentAt: messages.sentAt,
      deliveredAt: messages.deliveredAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(500);

  // Pull attachments for the loaded messages in a single follow-up
  // query, then group in memory. Two-step rather than a join because
  // a message with N attachments would otherwise duplicate the
  // message row N times and force a manual collapse — a flat IN
  // query is simpler and uses the message_attachments_message_idx
  // index. Empty when no messages have attachments (the common case).
  const messageIds = messageRows.map((m) => m.id);
  const attachmentRows = messageIds.length
    ? await db
        .select({
          id: messageAttachments.id,
          messageId: messageAttachments.messageId,
          filename: messageAttachments.filename,
          contentType: messageAttachments.contentType,
          sizeBytes: messageAttachments.sizeBytes,
          createdAt: messageAttachments.createdAt,
        })
        .from(messageAttachments)
        .where(inArray(messageAttachments.messageId, messageIds))
        .orderBy(asc(messageAttachments.createdAt), asc(messageAttachments.id))
    : [];

  const attachmentsByMessage = new Map<
    string,
    Array<{
      id: string;
      filename: string | null;
      contentType: string;
      sizeBytes: number;
      createdAt: string;
    }>
  >();
  for (const a of attachmentRows) {
    const arr = attachmentsByMessage.get(a.messageId) ?? [];
    arr.push({
      id: a.id,
      filename: a.filename ?? null,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      createdAt:
        a.createdAt instanceof Date
          ? a.createdAt.toISOString()
          : String(a.createdAt ?? new Date(0).toISOString()),
    });
    attachmentsByMessage.set(a.messageId, arr);
  }

  const toIso = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  const toIsoRequired = (v: unknown): string =>
    toIso(v) ?? new Date(0).toISOString();

  try {
    await logAudit({
      action: "conversation.view",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "conversations",
      targetId: id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: {
        source: "console",
        channel: header.channel,
        status: header.status,
        messageCount: messageRows.length,
      },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "conversations.detail: audit write failed",
    );
  }

  res.status(200).json({
    id: header.id,
    // Patient-flow subject — null for in_app rows.
    patientId: header.patientId,
    patientFirstName: header.patientFirstName ?? "",
    patientLastName: header.patientLastName ?? "",
    episodeId: header.episodeId,
    // Shop-customer subject — null for patient-flow rows. The UI
    // branches on these for in_app channel rendering.
    customerId: header.customerId,
    customerDisplayName: header.customerDisplayName ?? null,
    customerEmail: header.customerEmail ?? null,
    channel: header.channel,
    status: header.status,
    lastMessageAt: toIso(header.lastMessageAt),
    createdAt: toIsoRequired(header.createdAt),
    assignedAdminUserId: header.assignedAdminUserId ?? null,
    assignedAt: toIso(header.assignedAt),
    priority: header.priority ?? "normal",
    slaDueAt: toIso(header.slaDueAt),
    escalatedAt: toIso(header.escalatedAt),
    escalatedTo: header.escalatedTo ?? null,
    escalationReason: header.escalationReason ?? null,
    messages: messageRows.map((m) => ({
      id: m.id,
      direction: m.direction,
      senderRole: m.senderRole,
      body: m.body ?? "",
      deliveryStatus: m.deliveryStatus,
      sentAt: toIso(m.sentAt),
      deliveredAt: toIso(m.deliveredAt),
      createdAt: toIsoRequired(m.createdAt),
      // Always present (empty array when no media). Keeps the client
      // contract uniform and lets the UI render a single .map without
      // a null guard.
      attachments: attachmentsByMessage.get(m.id) ?? [],
    })),
  });
});

export default router;
