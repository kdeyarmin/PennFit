// GET /dashboard/summary — top-of-page operator counters.
//
// Five COUNT(*) queries over the resupply.* tables. No PHI in the
// response — every value is a row count. Run as separate queries
// rather than one giant UNION because (a) it's clearer, (b) the
// table-level indexes already make each one cheap, and (c) each one
// can fail independently and the operator gets a 500 with a clean
// log message rather than a partially-populated dashboard.
//
// We do NOT write an audit row for this endpoint: the response
// contains no PHI and no row identifiers, so there is nothing to
// audit beyond "the operator opened the dashboard" — covered by
// the existing /me audit on session bootstrap.

import { Router, type IRouter } from "express";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  conversations,
  episodes,
  fulfillments,
  getDbPool,
  patients,
} from "@workspace/resupply-db";

import { requireOperator } from "../../middlewares/requireOperator";

const router: IRouter = Router();

router.get("/dashboard/summary", requireOperator, async (_req, res) => {
  const db = drizzle(getDbPool());

  const countCol = sql<number>`count(*)::int`;

  const [activeConversationsRow] = await db
    .select({ count: countCol })
    .from(conversations)
    .where(
      inArray(conversations.status, [
        "open",
        "awaiting_patient",
        "awaiting_operator",
      ]),
    );

  const [awaitingOperatorRow] = await db
    .select({ count: countCol })
    .from(conversations)
    .where(eq(conversations.status, "awaiting_operator"));

  const [overdueEpisodesRow] = await db
    .select({ count: countCol })
    .from(episodes)
    .where(
      and(
        inArray(episodes.status, ["outreach_pending", "awaiting_response"]),
        lte(episodes.dueAt, sql`now()`),
      ),
    );

  const [fulfillmentsThisWeekRow] = await db
    .select({ count: countCol })
    .from(fulfillments)
    .where(gte(fulfillments.createdAt, sql`now() - interval '7 days'`));

  const [pausedPatientsRow] = await db
    .select({ count: countCol })
    .from(patients)
    .where(eq(patients.status, "paused"));

  res.status(200).json({
    activeConversations: activeConversationsRow?.count ?? 0,
    awaitingOperator: awaitingOperatorRow?.count ?? 0,
    overdueEpisodes: overdueEpisodesRow?.count ?? 0,
    fulfillmentsThisWeek: fulfillmentsThisWeekRow?.count ?? 0,
    pausedPatients: pausedPatientsRow?.count ?? 0,
  });
});

export default router;
