/**
 * Flip an outreach episode from `outreach_pending` → `awaiting_response`
 * after the first successful patient-facing reminder.
 *
 * The status exists in the schema, the reminder scan, and admin analytics,
 * but nothing used to write it — every open episode stayed
 * `outreach_pending` forever. Call this from the SMS / email / voice send
 * jobs once delivery reports `ok`. Guarded on the prior status so a
 * confirm/decline that raced ahead is never overwritten, and so a second
 * reminder on the same episode is a no-op.
 *
 * Fail-soft: a write blip must not fail the send job (the patient already
 * got the message).
 */

import type { OrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

export async function markEpisodeAwaitingResponse(
  supabase: OrgScopedClient,
  episodeId: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("episodes")
      .update({
        status: "awaiting_response",
        updated_at: new Date().toISOString(),
      })
      .eq("id", episodeId)
      .eq("status", "outreach_pending");
    if (error) {
      logger.warn(
        {
          event: "episode_awaiting_response_failed",
          episodeId,
          err: error.message,
        },
        "could not flip episode to awaiting_response after reminder send",
      );
    }
  } catch (err) {
    logger.warn(
      {
        event: "episode_awaiting_response_failed",
        episodeId,
        err: err instanceof Error ? err.message : String(err),
      },
      "could not flip episode to awaiting_response after reminder send",
    );
  }
}
