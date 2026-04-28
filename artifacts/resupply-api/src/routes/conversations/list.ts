// GET /conversations — paginated conversation queue.
//
// Joins patients to surface decrypted firstName + lastName so the
// queue can render a human-readable label without a second
// round-trip per row. Sort key: `lastMessageAt DESC NULLS LAST,
// createdAt DESC` so conversations with fresh activity surface
// first; brand-new conversations (no messages yet) fall back to
// createdAt order.
//
// Like the patient list, no audit row per page-flip — the
// /conversations/:id detail view is the one that writes the audit
// row, since that is where decrypted message bodies cross the wire.

import { Router, type IRouter } from "express";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  conversations,
  decrypt,
  getDbPool,
  patients,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const listQuery = z
  .object({
    status: z
      .enum(["open", "awaiting_patient", "awaiting_admin", "closed"])
      .optional(),
    channel: z.enum(["sms", "voice", "email"]).optional(),
    patientId: z.string().uuid().optional(),
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
  const { status, channel, patientId, limit, offset } = parsed.data;

  const filters: SQL[] = [];
  if (status) filters.push(eq(conversations.status, status));
  if (channel) filters.push(eq(conversations.channel, channel));
  if (patientId) filters.push(eq(conversations.patientId, patientId));
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
    .where(whereClause)
    .orderBy(
      sql`${conversations.lastMessageAt} DESC NULLS LAST, ${conversations.createdAt} DESC`,
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
      patientId: r.patientId,
      patientFirstName: r.patientFirstName ?? "",
      patientLastName: r.patientLastName ?? "",
      episodeId: r.episodeId,
      channel: r.channel,
      status: r.status,
      lastMessageAt: toIso(r.lastMessageAt),
      createdAt: toIsoRequired(r.createdAt),
    })),
    total: totalRow?.count ?? 0,
    limit,
    offset,
  });
});

export default router;
