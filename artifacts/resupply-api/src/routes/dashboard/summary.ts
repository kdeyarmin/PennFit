// GET /dashboard/summary — top-of-page admin counters.
//
// Five COUNT(*) queries over the resupply.* tables. No PHI in the
// response — every value is a row count. Run as separate queries
// rather than one giant UNION because (a) it's clearer, (b) the
// table-level indexes already make each one cheap, and (c) each one
// can fail independently and the admin gets a 500 with a clean
// log message rather than a partially-populated dashboard.
//
// We do NOT write an audit row for this endpoint: the response
// contains no PHI and no row identifiers, so there is nothing to
// audit beyond "the admin opened the dashboard" — covered by
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

import { requireAdmin } from "../../middlewares/requireAdmin";
import { getLatestPhiSweepStatus } from "./sweep-status";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAdmin, async (_req, res) => {
  const db = drizzle(getDbPool());

  const countCol = sql<number>`count(*)::int`;

  const [activeConversationsRow] = await db
    .select({ count: countCol })
    .from(conversations)
    .where(
      inArray(conversations.status, [
        "open",
        "awaiting_patient",
        "awaiting_admin",
      ]),
    );

  const [awaitingAdminRow] = await db
    .select({ count: countCol })
    .from(conversations)
    .where(eq(conversations.status, "awaiting_admin"));

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

  // Latest PHI sweep status — read-only projection over the
  // most recent `prescription.attachment.sweep` audit row. Helper
  // uses raw SQL via the shared pool (Rule 8 forbids importing
  // `auditLog` outside the audit lib, even for SELECTs — see
  // `sweep-status.ts` header). Defensive: helper returns null on
  // no-row-yet OR malformed metadata; we never let it 500 the
  // dashboard.
  const prescriptionAttachmentSweep = await getLatestPhiSweepStatus();

  res.status(200).json({
    activeConversations: activeConversationsRow?.count ?? 0,
    awaitingAdmin: awaitingAdminRow?.count ?? 0,
    overdueEpisodes: overdueEpisodesRow?.count ?? 0,
    fulfillmentsThisWeek: fulfillmentsThisWeekRow?.count ?? 0,
    pausedPatients: pausedPatientsRow?.count ?? 0,
    prescriptionAttachmentSweep,
  });
});

export default router;
