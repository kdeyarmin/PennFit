// reopen-after-decline.ts — a declined refill is a SKIP, not an exit.
//
// WHY THIS EXISTS
// ---------------
// Every decline path closes the episode `declined` and nothing opened the
// next one. That looks harmless until you follow what produces episodes:
// `openOutreachEpisode` is called by prescription create, the PacWare
// bootstrap, shipment evidence, the cycle sweep, and opt-in — and NOT by
// the reminder scan, which only reads cycles that already exist. The
// sweep does not help either: it reopens expired and assumed-shipped
// cycles, and `declined` is neither.
//
// So one "no thanks" removed a patient from resupply permanently, with no
// row anywhere recording that it had happened. It is invisible in exactly
// the way §1 of this branch is about: the ladder stops and nothing says
// so. And every channel told the patient the opposite — the SMS reply is
// "reply YES any time you are ready", the email confirmation says we will
// check back next cycle.
//
// ANCHORING — the part that is easy to get wrong
// ----------------------------------------------
// This anchors on the DECLINE, not on the last dispense. Opt-in
// (`reopenLadderAfterOptIn`) deliberately does the opposite, because a
// patient returning after STOP should come back already due. A decline is
// the reverse situation: the patient has looked at this cycle and said
// not now. Anchoring on their last dispense would reopen a cycle that is
// already overdue and remind them tomorrow — which is precisely what they
// just declined, and the fastest way to earn a STOP.
//
// An INACTIVE prescription is never resurrected: ending therapy is a
// clinical decision and a decline must not undo it.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { openOutreachEpisode } from "./open-outreach-episode";
import { logger } from "../logger";

/** Fallback cadence when a prescription carries none. Matches the other
 *  reopen paths (`reopenNextCycle`, `reopenLadderAfterOptIn`). */
const DEFAULT_CADENCE_DAYS = 90;

export interface ReopenAfterDeclineResult {
  /** A cycle exists for the prescription after this call. */
  reopened: boolean;
  /** …and this call is what opened it. False when an outreach-open cycle
   *  was already there — a replayed webhook, or a second click. */
  created: boolean;
  episodeId: string | null;
  /** Why nothing was opened, for the log. Never surfaced to a patient. */
  skipped:
    | "no_episode"
    | "episode_missing"
    | "prescription_inactive"
    | "lookup_failed"
    | null;
}

/**
 * Open the next cycle for the prescription behind a just-declined
 * episode.
 *
 * NEVER THROWS. A decline has already been acknowledged to the patient by
 * the time this runs, and failing the request afterwards would leave the
 * episode closed anyway while telling the patient something went wrong.
 * A failure is logged at warn with the episode id so it can be repaired.
 *
 * Idempotent: `openOutreachEpisode` hands back any outreach-open cycle
 * for the prescription rather than opening a second one, so a webhook
 * replay or a double click is a no-op.
 */
export async function reopenCycleAfterDecline(args: {
  orgId: string;
  /** The episode that was just closed `declined`. */
  episodeId: string | null;
  /** When the patient declined. The next cycle is one cadence from here. */
  at: Date;
}): Promise<ReopenAfterDeclineResult> {
  const none = (
    skipped: ReopenAfterDeclineResult["skipped"],
  ): ReopenAfterDeclineResult => ({
    reopened: false,
    created: false,
    episodeId: null,
    skipped,
  });

  if (!args.episodeId) return none("no_episode");

  try {
    const supabase = getOrgScopedClient(args.orgId);

    const { data: epRow, error: epErr } = await supabase
      .from("episodes")
      .select("patient_id, prescription_id")
      .eq("id", args.episodeId)
      .limit(1)
      .maybeSingle();
    if (epErr) throw epErr;
    const episode = epRow as {
      patient_id: string | null;
      prescription_id: string | null;
    } | null;
    if (!episode?.patient_id || !episode.prescription_id) {
      return none("episode_missing");
    }

    const { data: rxRow, error: rxErr } = await supabase
      .from("prescriptions")
      .select("cadence_days, status")
      .eq("id", episode.prescription_id)
      .limit(1)
      .maybeSingle();
    if (rxErr) throw rxErr;
    const rx = rxRow as { cadence_days: number | null; status: string } | null;
    // A prescription that is no longer active is a clinician's decision.
    if (!rx || rx.status !== "active") return none("prescription_inactive");

    const anchor = Number.isFinite(args.at.getTime()) ? args.at : new Date();
    const opened = await openOutreachEpisode({
      orgId: args.orgId,
      patientId: episode.patient_id,
      prescriptionId: episode.prescription_id,
      cadenceDays:
        typeof rx.cadence_days === "number" && rx.cadence_days > 0
          ? rx.cadence_days
          : DEFAULT_CADENCE_DAYS,
      from: anchor,
    });

    return {
      reopened: true,
      created: opened.created,
      episodeId: opened.episodeId,
      skipped: null,
    };
  } catch (err) {
    logger.warn(
      {
        event: "resupply.decline_reopen_failed",
        episodeId: args.episodeId,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "resupply: could not open the next cycle after a decline — this patient will not be reminded again until something else opens one",
    );
    return none("lookup_failed");
  }
}
