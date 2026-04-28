// GET /conversations/:id — conversation detail with decrypted messages.
//
// This is the only endpoint that surfaces decrypted message bodies to
// the admin console. Decryption happens in the SELECT projection
// via `decrypt(messages.body)` so plaintext PHI never lives in Node
// memory between Postgres and the JSON serialiser.
//
// Writes one `conversation.view` audit row with the conversation id
// as target. The metadata records the conversation channel + status
// for context and the size of the message timeline (count, not
// content). PHI does not enter the audit metadata.

import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  conversations,
  decrypt,
  getDbPool,
  messages,
  patients,
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
      patientFirstName: decrypt(patients.legalFirstName),
      patientLastName: decrypt(patients.legalLastName),
      episodeId: conversations.episodeId,
      channel: conversations.channel,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .leftJoin(patients, eq(patients.id, conversations.patientId))
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
      body: decrypt(messages.body),
      deliveryStatus: messages.deliveryStatus,
      sentAt: messages.sentAt,
      deliveredAt: messages.deliveredAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id));

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
      adminClerkId: req.adminClerkId ?? null,
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
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "conversations.detail: audit write failed",
    );
  }

  res.status(200).json({
    id: header.id,
    patientId: header.patientId,
    patientFirstName: header.patientFirstName ?? "",
    patientLastName: header.patientLastName ?? "",
    episodeId: header.episodeId,
    channel: header.channel,
    status: header.status,
    lastMessageAt: toIso(header.lastMessageAt),
    createdAt: toIsoRequired(header.createdAt),
    messages: messageRows.map((m) => ({
      id: m.id,
      direction: m.direction,
      senderRole: m.senderRole,
      body: m.body ?? "",
      deliveryStatus: m.deliveryStatus,
      sentAt: toIso(m.sentAt),
      deliveredAt: toIso(m.deliveredAt),
      createdAt: toIsoRequired(m.createdAt),
    })),
  });
});

export default router;
