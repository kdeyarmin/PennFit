// GET /conversations/:id/messages/:messageId/attachments/:attachmentId
//
// Streams the bytes of a single message attachment back to an
// authenticated admin. Mirrors the prescription-attachment download
// flow — same auth gate, same audit pattern, same GCS-stream
// piping shape — but scoped to {conversation, message, attachment}.
//
// Why a triple-keyed URL rather than just /attachments/:id:
//   The path makes the access-control predicate explicit AND
//   self-documenting in audit logs. A "conversation X viewed
//   attachment Y" entry is more searchable than "attachment Y
//   downloaded with no context". The conversation + message guards
//   also prevent enumerating attachments by id — a malformed URL
//   like /conversations/<wrong>/messages/<wrong>/attachments/<id>
//   404s without leaking that the attachment exists at all.
//
// We don't expose a presigned GCS URL directly because:
//   (1) ACL — these objects are private and the practice expects
//       every PHI download to be audited; a presigned URL is a
//       bearer token that bypasses our audit horizon once it
//       leaves the server.
//   (2) Content-Disposition — we want to set a deterministic
//       filename ("mms-<sid>.jpg") so "Save as…" works regardless
//       of whether the dashboard fetches it inline or via a new tab.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  conversations,
  getDbPool,
  messageAttachments,
  messages,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idsParam = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  attachmentId: z.string().uuid(),
});

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

router.get(
  "/conversations/:id/messages/:messageId/attachments/:attachmentId",
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const db = drizzle(getDbPool());

    // Single SQL with INNER joins enforces the full predicate:
    // {conversation exists} ∧ {message belongs to that conversation}
    // ∧ {attachment belongs to that message}. A mismatch in any
    // dimension → no row → 404, indistinguishable from "doesn't
    // exist" so we don't leak structure to enumeration.
    const rows = await db
      .select({
        objectKey: messageAttachments.objectKey,
        filename: messageAttachments.filename,
        contentType: messageAttachments.contentType,
      })
      .from(messageAttachments)
      .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(conversations.id, ids.data.id),
          eq(messages.id, ids.data.messageId),
          eq(messageAttachments.id, ids.data.attachmentId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    let file;
    try {
      file = await objectStorage.getObjectEntityFile(row.objectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        // Row points to a vanished bucket object (manual cleanup,
        // sweep race). Tell the dashboard "no longer available"
        // rather than 500 — it can render a "removed" affordance.
        res.status(404).json({ error: "not_found" });
        return;
      }
      req.log.error(
        { err, attachment_id: ids.data.attachmentId },
        "message_attachment_lookup_failed",
      );
      res.status(500).json({ error: "download_failed" });
      return;
    }

    await logAudit({
      action: "conversation.attachment.download",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "message_attachments",
      targetId: ids.data.attachmentId,
      metadata: {
        conversation_id: ids.data.id,
        message_id: ids.data.messageId,
        // Content-type is bounded technical metadata; safe to log.
        content_type: row.contentType,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "conversation.attachment.download audit write failed",
      );
    });

    try {
      // Cache for 5 minutes — these are PHI, so we want browser
      // cache pressure low (Back button shouldn't show a stale
      // image weeks later) but tab-local re-renders shouldn't
      // re-download the bytes. The downloadObject helper sets
      // Cache-Control: private,max-age=<ttl> for non-public ACLs.
      const response = await objectStorage.downloadObject(file, 300);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      // Inline disposition so <img src="..."> renders directly in
      // the conversation view; clients that prefer a download can
      // append ?download=1 (not implemented here — they can also
      // right-click → Save).
      if (row.filename) {
        const safeAscii = row.filename.replace(/[^\x20-\x7E]/g, "_");
        const encoded = encodeURIComponent(row.filename);
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${safeAscii}"; filename*=UTF-8''${encoded}`,
        );
      }
      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      req.log.error(
        { err, attachment_id: ids.data.attachmentId },
        "message_attachment_stream_failed",
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "download_failed" });
      } else {
        res.end();
      }
    }
  },
);

export default router;
