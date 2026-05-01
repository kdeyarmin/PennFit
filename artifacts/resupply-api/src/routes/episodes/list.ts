// GET /episodes — paginated episode queue.
//
// The synthetic `overdue` status is the admin's actionable queue:
// episodes still in outreach (`outreach_pending` or
// `awaiting_response`) whose dueAt is in the past. Sort key for the
// overdue queue is oldest-due-first (the most overdue is most
// urgent). For non-overdue queries the sort key is createdAt DESC.
//
// Joins prescriptions for itemSku + cadenceDays and patients for
// firstName + lastName so the queue table renders without N+1
// lookups. PHI surfaced is the same shape as the patient list —
// name only, never phone or email.

import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  episodes,
  getDbPool,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

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
    // Free-text filter (A8). Substring match against patient legal
    // name OR exact match against patient/episode id. The 64-char
    // cap mirrors the longest plausible "first last" string and
    // bounds LIKE pattern complexity. We trim BEFORE validating so
    // an all-whitespace query is treated as "no filter" — the page
    // sends the input box value directly without trimming so the
    // single-source-of-truth lives here.
    q: z
      .string()
      .max(64)
      .optional()
      .transform((v) => {
        const t = v?.trim() ?? "";
        return t === "" ? undefined : t;
      }),
  })
  .strict();

// Build the search clause for the free-text `q` filter, used by
// both the list endpoint and the counts endpoint so the chips
// reflect the same row-set as the table. The clause is an
// OR-union of: exact episode-id (cheap PK lookup), exact
// patient-id, OR case-insensitive substring against the patient
// first OR last name. ILIKE is a full-table scan but admin-only /
// small dataset keeps it acceptable.
export function episodesSearchClause(needle: string): SQL {
  const pattern = `%${needle}%`;
  return sql`(${episodes.id} = ${needle} OR ${episodes.patientId} = ${needle} OR ${patients.legalFirstName} ILIKE ${pattern} OR ${patients.legalLastName} ILIKE ${pattern})`;
}

const router: IRouter = Router();

router.get("/episodes", requireAdmin, async (req, res) => {
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
  const { status, limit, offset, q } = parsed.data;
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
  if (q) filters.push(episodesSearchClause(q));
  const whereClause = filters.length ? and(...filters) : undefined;

  const db = drizzle(getDbPool());

  // The count query needs the same patient join when `q` is in
  // play because the search clause references decrypted patient
  // columns. Without the join the COUNT query would 500 with
  // "missing FROM-clause entry for table patients". We only pay
  // the join cost when q is set so the common no-search case stays
  // a single-table count.
  const totalQuery = q
    ? db
        .select({ count: sql<number>`count(*)::int` })
        .from(episodes)
        .leftJoin(patients, eq(patients.id, episodes.patientId))
        .where(whereClause)
    : db
        .select({ count: sql<number>`count(*)::int` })
        .from(episodes)
        .where(whereClause);
  const [totalRow] = await totalQuery;

  const orderBy = isOverdue
    ? [asc(episodes.dueAt)]
    : [desc(episodes.createdAt)];

  const rows = await db
    .select({
      id: episodes.id,
      patientId: episodes.patientId,
      patientFirstName: patients.legalFirstName,
      patientLastName: patients.legalLastName,
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
