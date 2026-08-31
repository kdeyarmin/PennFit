// reanchor-due-at.ts — move an open cycle's due date onto better evidence.
//
// `episodes.due_at` is written once, at open time, from the cadence the
// caller happened to know. When real shipment evidence arrives later —
// a PacWare import days after the box left, or a CSR marking an order
// shipped — the stored date is anchored on the wrong event (queue time,
// or a confirm) and every surface that reads it is wrong with it:
// /admin/episodes' overdue queue, the PacWare resupply-due export, and
// the reorder-reminders funnel.
//
// This does NOT reset the ladder. Pushing the date out is correct — we
// contacted the patient early because we had no ship date — but flipping
// `awaiting_response` back to `outreach_pending` would restart the
// escalation from step one and re-nag someone we are already mid-
// conversation with.

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  EPISODE_EXPIRY_DAYS,
  OUTREACH_OPEN_EPISODE_STATUSES,
} from "@workspace/resupply-domain";

import { logger } from "../logger";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReanchorSource =
  | "shipment_evidence"
  | "grace_sweep"
  | "scan_correction";

/**
 * Re-anchor an OUTREACH-OPEN episode's `due_at` (and its matching
 * `expires_at`).
 *
 * Returns true when a row actually moved. A confirmed, declined, or
 * already-closed episode matches zero rows and returns false — that is
 * the expected outcome for late evidence on a cycle that has already
 * ended, not an error.
 *
 * NOTE ON `metadata`: PostgREST cannot merge JSONB in an update, so this
 * OVERWRITES the column. Safe today — nothing else writes or reads it —
 * but do not assume merge semantics if that changes.
 */
export async function reanchorEpisodeDueAt(args: {
  orgId: string;
  episodeId: string;
  dueAt: Date;
  source: ReanchorSource;
}): Promise<boolean> {
  const supabase = getOrgScopedClient(args.orgId);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("episodes")
    .update({
      due_at: args.dueAt.toISOString(),
      expires_at: new Date(
        args.dueAt.getTime() + EPISODE_EXPIRY_DAYS * DAY_MS,
      ).toISOString(),
      metadata: { reanchored_from: args.source, reanchored_at: nowIso },
      updated_at: nowIso,
    })
    .eq("id", args.episodeId)
    .in("status", [...OUTREACH_OPEN_EPISODE_STATUSES])
    .select("id");

  if (error) {
    // Advisory bookkeeping: the cadence predicate still has the
    // fulfillment history to fall back on, so a failure here must not
    // fail the shipment write that triggered it.
    logger.warn(
      {
        event: "resupply.episode_reanchor_failed",
        episodeId: args.episodeId,
        source: args.source,
        errName: error instanceof Error ? error.name : "unknown",
      },
      "resupply: episode due_at re-anchor failed",
    );
    return false;
  }

  return (data ?? []).length > 0;
}
