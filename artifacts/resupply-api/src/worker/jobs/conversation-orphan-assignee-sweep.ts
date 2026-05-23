// pg-boss job: weekly sweep that unassigns conversations whose
// assignee is a revoked admin.
//
// Why this exists:
//   The /admin/conversations/:id/claim endpoint stamps
//   conversations.assigned_admin_user_id when a CSR self-assigns.
//   Nothing else clears that pointer when the assignee later leaves
//   the team. The Team admin UI revokes the admin row
//   (admin_users.status = 'revoked' + revoked_at = now()) but the
//   conversation rows the now-gone CSR was holding stay pinned to
//   them indefinitely. The "mine" view drops the conversations
//   silently (the revoked admin never signs in again), and the
//   default queue's "view=unassigned" filter excludes them because
//   they LOOK assigned — supervisors only notice these orphans by
//   accident, weeks later.
//
// What this job does:
//   1. Page through conversations with a non-null
//      assigned_admin_user_id whose status is still active in the
//      queue ("open", "awaiting_admin", "awaiting_patient").
//   2. For each page, look up which of those assignee_ids are
//      revoked admins (admin_users.status='revoked').
//   3. For every conversation whose assignee is revoked, UPDATE
//      assigned_admin_user_id=NULL and assigned_at=NULL so the
//      conversation re-emerges in the unassigned queue for a live
//      CSR to claim.
//
// Scheduling: Sunday 04:13 UTC (weekly, off-peak; well after the
// nightly retention sweep at 03:11 and well before the Monday
// 13:17 lapsed-customer-winback). Weekly is the right cadence — a
// CSR turnover event isn't urgent on the day-of (the conversation
// just sits in the queue an extra few days), but it MUST be
// caught before the conversation's SLA gets stale.
//
// Idempotency: every transition is a no-op once the row is
// unassigned (the next sweep won't see it because the
// `assigned_admin_user_id IS NOT NULL` filter excludes it).
//
// Audit: one row per unassignment, action
// 'conversation.orphan_unassigned', metadata records the prior
// assignee + status so a supervisor can reconstruct what happened.

import type PgBoss from "pg-boss";

import { logAuditBestEffort } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const SWEEP_JOB = "conversations.orphan-assignee-sweep";
const SWEEP_CRON = "13 4 * * 0";

// Conversation statuses that still belong in a CSR queue. The other
// statuses (e.g. "closed") are terminal and don't need re-routing
// even when the assignee is gone — the historical pinning is fine.
const ACTIVE_STATUSES = ["open", "awaiting_admin", "awaiting_patient"] as const;

// Page size for the assigned-conversations scan. 200 keeps the
// per-page memory bounded and the assignee-id lookup query small
// enough that PostgREST's `.in()` clause doesn't blow up.
const SWEEP_PAGE_SIZE = 200;

// Maximum number of conversations to unassign in a single tick.
// Defensive cap so a one-time mass revocation event doesn't burn
// the whole worker for hours; subsequent weekly ticks finish the
// rest. In practice the steady-state count is near zero.
const MAX_PER_TICK = 5_000;

interface SweepStats {
  scanned: number;
  unassigned: number;
}

/** Exported for test injection. Runs one sweep cycle and returns
 *  the counts so a test can assert behavior without scheduling. */
export async function runOrphanAssigneeSweep(): Promise<SweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  let scanned = 0;
  let unassigned = 0;
  let offset = 0;

  while (unassigned < MAX_PER_TICK) {
    // 1. Fetch the next page of assigned conversations in active
    //    statuses. Ordered by `assigned_at ASC NULLS LAST` so we
    //    surface the OLDEST orphans first — those are the ones
    //    closest to an SLA breach.
    const { data: page, error: pageErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id, assigned_admin_user_id, assigned_at, status")
      .not("assigned_admin_user_id", "is", null)
      .in("status", ACTIVE_STATUSES as unknown as string[])
      .order("assigned_at", { ascending: true, nullsFirst: false })
      .range(offset, offset + SWEEP_PAGE_SIZE - 1);
    if (pageErr) throw pageErr;
    const rows = page ?? [];
    if (rows.length === 0) break;
    scanned += rows.length;

    // 2. Distinct assignee ids on this page. Look them up once
    //    against admin_users and keep only the revoked ones.
    const assigneeIds = Array.from(
      new Set(
        rows
          .map((r) => r.assigned_admin_user_id)
          .filter((v): v is string => v !== null),
      ),
    );
    if (assigneeIds.length === 0) {
      offset += rows.length;
      continue;
    }
    const { data: revokedAssignees, error: assigneeErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("id")
      .in("id", assigneeIds)
      .eq("status", "revoked");
    if (assigneeErr) throw assigneeErr;
    const revokedIds = new Set(
      (revokedAssignees ?? []).map((r) => r.id),
    );

    // 3. For every conversation whose assignee is in the revoked
    //    set, clear the assignment. We issue one UPDATE per row
    //    (vs a single `.in("id", [...])` UPDATE) so a per-row
    //    failure on a poison row doesn't roll back the whole
    //    batch. The volume is bounded by MAX_PER_TICK and weekly
    //    cadence; the steady-state count is near zero.
    for (const row of rows) {
      if (
        !row.assigned_admin_user_id ||
        !revokedIds.has(row.assigned_admin_user_id)
      ) {
        continue;
      }
      const { error: updErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({
          assigned_admin_user_id: null,
          assigned_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        // Re-check the assignee at update time so a concurrent
        // /claim by a live CSR (e.g. a brand-new hire was just
        // mapped to the same auth_user_id) doesn't get clobbered.
        // PostgREST has no transactional locking; the eq() guard
        // is the cheapest equivalent that catches the race.
        .eq("assigned_admin_user_id", row.assigned_admin_user_id);
      if (updErr) throw updErr;
      unassigned += 1;
      await logAuditBestEffort(
        {
          action: "conversation.orphan_unassigned",
          adminEmail: "system:cron:conversation-orphan-assignee-sweep",
          adminUserId: null,
          targetTable: "conversations",
          targetId: row.id,
          metadata: {
            prior_assignee_id: row.assigned_admin_user_id,
            prior_assigned_at: row.assigned_at,
            status_at_unassign: row.status,
          },
        },
        {
          contextLabel: "conversation_orphan_assignee_sweep",
          onWriteFailure: (failure) => {
            logger.warn(
              failure,
              "conversation-orphan-assignee-sweep: audit write failed",
            );
          },
        },
      );
      if (unassigned >= MAX_PER_TICK) break;
    }

    // Advance the offset by the page size — NOT by the
    // unassigned-on-this-page count. Rows whose assignee is still
    // active are intentionally left in place and we don't want to
    // re-visit them on the next iteration.
    if (rows.length < SWEEP_PAGE_SIZE) break;
    offset += rows.length;
  }

  return { scanned, unassigned };
}

export async function registerConversationOrphanAssigneeSweepJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(SWEEP_JOB);

  await boss.work(SWEEP_JOB, async () => {
    try {
      const stats = await runOrphanAssigneeSweep();
      logger.info(
        {
          event: "conversation-orphan-assignee-sweep.completed",
          ...stats,
        },
        "conversation-orphan-assignee-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "conversation-orphan-assignee-sweep: failed",
      );
      throw err;
    }
  });

  await boss.schedule(SWEEP_JOB, SWEEP_CRON);
  logger.info(
    { cron: SWEEP_CRON },
    "conversation-orphan-assignee-sweep scheduled",
  );
}
