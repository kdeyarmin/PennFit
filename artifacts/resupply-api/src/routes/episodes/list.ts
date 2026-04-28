// GET /episodes — paginated episode queue.
//
// The synthetic `overdue` status is the operator's actionable queue:
// episodes still in outreach (`outreach_pending` or
// `awaiting_response`) whose dueAt is in the past. Sort key for the
// overdue queue is oldest-due-first (the most overdue is most
// urgent). For non-overdue queries the sort key is createdAt DESC.
//
// Joins prescriptions for itemSku + cadenceDays and patients for
// the decrypted firstName + lastName so the queue table renders
// without N+1 lookups. PHI surfaced is the same shape as the
// patient list — name only, never phone or email.

import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  decrypt,
  episodes,
  getDbPool,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import { requireOperator } from "../../middlewares/requireOperator";

const listQuery = z
  .object({
    status: z
      .enum([
        "overdue",
        "outreach_pending",
        "awaiting_response",
        "confirmed",
        "declined",
        "expired",
        "fulfilled",
        "canceled",
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get("/episodes", requireOperator, async (req, res) => {
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
  const { status, limit, offset } = parsed.data;
  const isOverdue = status === "overdue";

  const filters: SQL[] = [];
  if (isOverdue) {
    filters.push(
      inArray(episodes.status, ["outreach_pending", "awaiting_response"]),
    );
    filters.push(lte(episodes.dueAt, sql`now()`));
  } else if (status) {
    filters.push(eq(episodes.status, status));
  }
  const whereClause = filters.length ? and(...filters) : undefined;

  const db = drizzle(getDbPool());

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(episodes)
    .where(whereClause);

  const orderBy = isOverdue
    ? [asc(episodes.dueAt)]
    : [desc(episodes.createdAt)];

  const rows = await db
    .select({
      id: episodes.id,
      patientId: episodes.patientId,
      patientFirstName: decrypt(patients.legalFirstName),
      patientLastName: decrypt(patients.legalLastName),
      prescriptionId: episodes.prescriptionId,
      itemSku: prescriptions.itemSku,
      cadenceDays: prescriptions.cadenceDays,
      status: episodes.status,
      dueAt: episodes.dueAt,
      daysOverdue: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - ${episodes.dueAt})) / 86400))::int`,
      expiresAt: episodes.expiresAt,
      createdAt: episodes.createdAt,
    })
    .from(episodes)
    .leftJoin(patients, eq(patients.id, episodes.patientId))
    .leftJoin(prescriptions, eq(prescriptions.id, episodes.prescriptionId))
    .where(whereClause)
    .orderBy(...orderBy)
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
      prescriptionId: r.prescriptionId,
      itemSku: r.itemSku ?? "",
      cadenceDays: r.cadenceDays ?? 0,
      status: r.status,
      dueAt: toIsoRequired(r.dueAt),
      daysOverdue: Number(r.daysOverdue ?? 0),
      expiresAt: toIso(r.expiresAt),
      createdAt: toIsoRequired(r.createdAt),
    })),
    total: totalRow?.count ?? 0,
    limit,
    offset,
  });
});

export default router;
