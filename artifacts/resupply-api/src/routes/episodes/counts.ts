// GET /episodes/counts — per-status counts for the dispatcher
// strip on the Episodes page (A3).
//
// Implementation strategy:
//   One query that GROUP BYs the real status column + a separate
//   pass that computes the synthetic `overdue` bucket. Doing both
//   in a single CTE would be more elegant but needs raw SQL — the
//   two-query path stays inside drizzle's typed builder, runs
//   server-side in <5ms on the expected dataset, and reads
//   trivially when a future maintainer needs to add a new status.
//
// The `q` filter mirrors /episodes exactly (same `episodesSearchClause`
// helper). When set we join patients so the decrypted-name ILIKE
// can resolve; otherwise the join is omitted to keep the query
// single-table.

import { Router, type IRouter } from "express";
import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { episodes, getDbPool, patients } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { episodesSearchClause } from "./list";

// The full set of episode statuses — kept as a literal union so the
// `result` record below is exhaustively-typed without a runtime
// constant array (the array form trips no-unused-vars; the union
// form documents intent and lets TS catch a missing key).
type Status =
  | "outreach_pending"
  | "awaiting_response"
  | "confirmed"
  | "declined"
  | "expired"
  | "fulfilled"
  | "canceled";

const countsQuery = z
  .object({
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

const router: IRouter = Router();

router.get("/episodes/counts", requireAdmin, async (req, res) => {
  const parsed = countsQuery.safeParse(req.query);
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
  const { q } = parsed.data;

  const baseFilters: SQL[] = [];
  if (q) baseFilters.push(episodesSearchClause(q));
  const baseWhere = baseFilters.length ? and(...baseFilters) : undefined;

  const db = drizzle(getDbPool());

  // Group-by on the real status column. Empty buckets need to
  // appear as 0 (not absent) so the chip strip stays stable —
  // we seed `result` with all known statuses, then merge.
  const groupQuery = q
    ? db
        .select({
          status: episodes.status,
          count: sql<number>`count(*)::int`,
        })
        .from(episodes)
        .leftJoin(patients, eq(patients.id, episodes.patientId))
        .where(baseWhere)
        .groupBy(episodes.status)
    : db
        .select({
          status: episodes.status,
          count: sql<number>`count(*)::int`,
        })
        .from(episodes)
        .where(baseWhere)
        .groupBy(episodes.status);
  const groupRows = await groupQuery;

  // Synthetic `overdue` bucket: outreach_pending|awaiting_response
  // with dueAt <= now(). Re-uses the same q filter so it stays in
  // sync with the chips.
  const overdueFilters: SQL[] = [
    inArray(episodes.status, ["outreach_pending", "awaiting_response"]),
    lte(episodes.dueAt, sql`now()`),
  ];
  if (q) overdueFilters.push(episodesSearchClause(q));
  const overdueQuery = q
    ? db
        .select({ count: sql<number>`count(*)::int` })
        .from(episodes)
        .leftJoin(patients, eq(patients.id, episodes.patientId))
        .where(and(...overdueFilters))
    : db
        .select({ count: sql<number>`count(*)::int` })
        .from(episodes)
        .where(and(...overdueFilters));
  const [overdueRow] = await overdueQuery;

  const result: Record<Status | "overdue" | "all", number> = {
    overdue: overdueRow?.count ?? 0,
    outreach_pending: 0,
    awaiting_response: 0,
    confirmed: 0,
    declined: 0,
    expired: 0,
    fulfilled: 0,
    canceled: 0,
    all: 0,
  };
  for (const row of groupRows) {
    const s = row.status as Status | undefined;
    if (s && s in result) {
      result[s] = row.count;
    }
    result.all += row.count;
  }

  res.status(200).json(result);
});

export default router;
