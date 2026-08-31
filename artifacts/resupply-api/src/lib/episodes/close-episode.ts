// close-episode.ts — the one way a resupply cycle ends.
//
// WHY ONE HELPER
// --------------
// Before this existed, closing an episode was open-coded at each exit:
// the SMS decline path and the voice decline path each ran their own
// guarded UPDATE, and the other three exits (opt-out, expiry, shipment)
// had no writer at all. The result was a lifecycle whose terminal states
// were read by analytics everywhere and written almost nowhere — see the
// header of migration 0538.
//
// CONTRACT
//   * Only an IN-PROGRESS episode closes. The status guard is applied in
//     the UPDATE itself (`.in("status", OUTREACH_OPEN_EPISODE_STATUSES)`),
//     so two racing exits — an email click and an SMS reply landing
//     together, or a webhook replay — are arbitrated by Postgres. The
//     loser matches zero rows and reports `closed: false`; it is NOT an
//     error, and callers must not retry it.
//   * `confirmed` is deliberately closeable to `fulfilled` / `canceled`:
//     a confirmed order still has to ship, or be cancelled. That is the
//     one non-in-progress source status accepted, and it is opt-in via
//     `allowFromConfirmed` so an ordinary decline can never quietly
//     reverse a confirmation.
//   * Every close records WHY (`closed_reason`) and WHEN (`closed_at`).
//     A funnel that only counts drop-outs cannot tell an operator what
//     to fix.
//   * Throws on a real DB error. A caller on a patient-facing path
//     (an SMS reply we must ack) decides for itself whether to swallow;
//     this helper does not decide that for them. What it will NOT do is
//     report success for a write that did not happen.
//   * No PHI: it reads and writes ids, a status, and a reason code.

import {
  OUTREACH_OPEN_EPISODE_STATUSES,
  buildEpisodeClosure,
  type EpisodeClosedReason,
  type TerminalEpisodeStatus,
} from "@workspace/resupply-domain";
import { getOrgScopedClient } from "@workspace/resupply-db";

/** The statuses this helper writes: the terminal set. `confirmed` is not
 *  one of them — confirming is `placeResupplyOrderForConversation`'s job,
 *  and it owns the entitlement / coverage / refill-window guards that go
 *  with it. */
export type ClosableEpisodeStatus = TerminalEpisodeStatus;

export interface CloseEpisodeInput {
  orgId: string;
  episodeId: string;
  /** Scopes the write to the patient the caller believes owns the
   *  episode. An inbound-channel caller has this from its own lookup;
   *  passing it makes a mis-bound conversation match zero rows rather
   *  than close a stranger's cycle. */
  patientId?: string;
  status: ClosableEpisodeStatus;
  /** Must be legal for `status` — `buildEpisodeClosure` throws otherwise,
   *  so a mis-paired reason fails here rather than mis-bucketing a report
   *  weeks later. */
  reason: EpisodeClosedReason;
  /** The fulfillment that satisfied the cycle. Only meaningful for
   *  `fulfilled`. */
  fulfillmentId?: string;
  /** When the cycle ended. Defaults to now. The shipment path passes the
   *  actual SHIP date so time-to-fulfil stays honest when a PacWare
   *  import lands days after the box left. */
  at?: Date;
  /** Also accept `confirmed` as a source status. Set by the shipment and
   *  cancellation paths, which legitimately act on an order that is
   *  already on the books. */
  allowFromConfirmed?: boolean;
}

export interface CloseEpisodeResult {
  /** False when the episode had already left the in-progress set —
   *  another exit won the race, or it was never open. Not an error. */
  closed: boolean;
}

export async function closeEpisode(
  input: CloseEpisodeInput,
): Promise<CloseEpisodeResult> {
  const supabase = getOrgScopedClient(input.orgId);
  const closure = buildEpisodeClosure(
    input.status,
    input.reason,
    input.at ?? new Date(),
  );

  // `address_hold` is included: a cycle parked on an address change is
  // still live, and an opt-out / decline / cancel must be able to end it.
  const fromStatuses: string[] = [...OUTREACH_OPEN_EPISODE_STATUSES];
  if (input.allowFromConfirmed) fromStatuses.push("confirmed");

  let query = supabase
    .from("episodes")
    .update({
      ...closure,
      ...(input.fulfillmentId
        ? { closing_fulfillment_id: input.fulfillmentId }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.episodeId)
    .in("status", fromStatuses);

  if (input.patientId) query = query.eq("patient_id", input.patientId);

  const { data, error } = await query.select("id");
  if (error) throw error;

  return { closed: (data ?? []).length > 0 };
}

/**
 * Close every in-progress episode a patient still has open.
 *
 * Used by the opt-out path: a STOP leaves the patient `paused`, which
 * stops the escalation sweep, but the episode rows themselves stayed
 * `outreach_pending` forever — polluting the due list, the funnel, and
 * `openOutreachEpisode`'s idempotency check (which would hand back the
 * stale row instead of opening a fresh cycle when the patient returns).
 *
 * Returns the number of episodes actually closed. Never throws for a
 * patient with nothing open.
 */
export async function closeOpenEpisodesForPatient(input: {
  orgId: string;
  patientId: string;
  status: ClosableEpisodeStatus;
  reason: EpisodeClosedReason;
  at?: Date;
}): Promise<{ closedCount: number }> {
  const supabase = getOrgScopedClient(input.orgId);
  const closure = buildEpisodeClosure(
    input.status,
    input.reason,
    input.at ?? new Date(),
  );

  const { data, error } = await supabase
    .from("episodes")
    .update({ ...closure, updated_at: new Date().toISOString() })
    .eq("patient_id", input.patientId)
    .in("status", [...OUTREACH_OPEN_EPISODE_STATUSES])
    .select("id");
  if (error) throw error;

  return { closedCount: (data ?? []).length };
}
