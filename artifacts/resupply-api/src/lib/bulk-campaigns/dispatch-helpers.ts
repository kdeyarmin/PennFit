// Pure helpers for the bulk-campaign send worker.
//
// Two concerns, kept separate from the worker plumbing so each is
// individually testable without standing up pg-boss or Supabase:
//
//   1. Batch sizing — given a per-minute throttle, how many
//      recipients should one tick claim, and how long until the
//      next tick should fire?
//   2. Status transition gates — which from/to status pairs are
//      legal for the campaign lifecycle? The Phase A schema lists
//      five statuses (draft / sending / sent / paused / cancelled);
//      the worker mutates between them, plus the API does (start,
//      pause, resume, cancel).

/** Worker tick cadence. Six ticks per minute means the smallest
 *  useful throttle is 6/min (one send per tick). Larger throttles
 *  scale the batch size, not the cadence — keeps tick latency
 *  predictable. */
export const TICKS_PER_MINUTE = 6;
export const TICK_INTERVAL_SECONDS = 60 / TICKS_PER_MINUTE; // = 10

/**
 * Given a per-minute throttle, return the batch size per tick.
 * Minimum 1 — a throttle of 1 still sends one per tick (six per
 * minute is rounded up rather than blocking the campaign forever).
 * Maximum 3600 (the schema CHECK) divided by TICKS_PER_MINUTE =
 * 600 sends per tick at the ceiling.
 */
export function batchSizeForThrottle(throttlePerMinute: number): number {
  if (!Number.isFinite(throttlePerMinute) || throttlePerMinute < 1) {
    return 1;
  }
  return Math.max(1, Math.ceil(throttlePerMinute / TICKS_PER_MINUTE));
}

// ── Campaign status transitions ────────────────────────────────────

export type CampaignStatus =
  | "draft"
  | "sending"
  | "sent"
  | "paused"
  | "cancelled";

/**
 * Allowed status transitions for a bulk campaign. Mirrors the schema
 * comment in lib/resupply-db/src/schema/bulk-campaigns.ts.
 *
 *   draft     -> sending | cancelled
 *   sending   -> sent | paused | cancelled
 *   paused    -> sending | cancelled
 *   sent      -> (terminal)
 *   cancelled -> (terminal)
 */
export const CAMPAIGN_TRANSITIONS: Record<
  CampaignStatus,
  readonly CampaignStatus[]
> = {
  draft: ["sending", "cancelled"],
  sending: ["sent", "paused", "cancelled"],
  paused: ["sending", "cancelled"],
  sent: [],
  cancelled: [],
};

export function isLegalCampaignTransition(
  from: CampaignStatus,
  to: CampaignStatus,
): boolean {
  if (from === to) return true;
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

// ── Custom-args envelope (for SendGrid event correlation) ──────────

/**
 * SendGrid custom_args are echoed back on every event webhook for
 * the message. The send worker sets these so the inbound webhook
 * can correlate a delivered/bounced/spam event to the campaign
 * recipient row.
 *
 * Kept here (as a pure helper) so the test suite can assert the
 * shape without booting the worker.
 */
export function customArgsFor(
  campaignId: string,
  recipientRowId: string,
): Record<string, string> {
  return {
    bulk_campaign_id: campaignId,
    bulk_campaign_recipient_id: recipientRowId,
  };
}
