// Reorder-reminder funnel — pure aggregation.
//
// Reduces the raw episode / conversation / fulfillment rows for a window into
// the funnel the /admin/reorder-reminders page renders:
//
//   due → reminded → confirmed → shipped
//
// plus a per-channel breakdown (which channel reached the patients who
// actually reordered). PURE: no DB, no Date.now() — the route does the read,
// this is the math (mirrors lib/analytics/aggregate.ts).

/** The reminder ladder channels we break the funnel down by. */
export const FUNNEL_CHANNELS = ["sms", "email", "voice"] as const;
export type FunnelChannel = (typeof FUNNEL_CHANNELS)[number];

/** Episode statuses that mean the patient agreed to reorder. `fulfilled`
 *  implies it was confirmed earlier in the lifecycle. */
const CONFIRMED_STATUSES = new Set(["confirmed", "fulfilled"]);

export interface ReorderFunnelEpisode {
  id: string;
  status: string;
}
export interface ReorderFunnelConversation {
  episodeId: string;
  channel: string;
}

export interface ChannelStat {
  /** Episodes that got at least one reminder on this channel. */
  reminded: number;
  /** …of those, how many the patient confirmed. */
  confirmed: number;
  /** …of those, how many actually shipped. */
  shipped: number;
}

export interface ReorderFunnelResult {
  /** Episodes that became due in the window (the funnel mouth). */
  due: number;
  /** …that received at least one reminder on any channel. */
  reminded: number;
  /** …that the patient confirmed (status confirmed/fulfilled). */
  confirmed: number;
  /** …that actually shipped (a fulfillment with shipped_at). */
  shipped: number;
  /** Per-channel breakdown. An episode reminded on two channels counts in
   *  both, so the column answers "of the patients we reached on X, how many
   *  reordered". */
  byChannel: Record<FunnelChannel, ChannelStat>;
  /** Stage-to-stage conversion, 4-dp, null when the prior stage is empty. */
  rates: {
    /** reminded / due */
    remindedOfDue: number | null;
    /** confirmed / reminded */
    confirmedOfReminded: number | null;
    /** shipped / confirmed */
    shippedOfConfirmed: number | null;
  };
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/**
 * Aggregate the reorder funnel. `shippedEpisodeIds` is the set of episode ids
 * with a fulfillment that has a `shipped_at` (computed by the route from the
 * fulfillments read).
 */
export function aggregateReorderFunnel(
  episodes: ReorderFunnelEpisode[],
  conversations: ReorderFunnelConversation[],
  shippedEpisodeIds: ReadonlySet<string>,
): ReorderFunnelResult {
  // episode id → channels it was reminded on (ladder channels only).
  const channelsByEpisode = new Map<string, Set<FunnelChannel>>();
  for (const c of conversations) {
    if (!isFunnelChannel(c.channel)) continue;
    const set = channelsByEpisode.get(c.episodeId) ?? new Set<FunnelChannel>();
    set.add(c.channel);
    channelsByEpisode.set(c.episodeId, set);
  }

  const byChannel: Record<FunnelChannel, ChannelStat> = {
    sms: { reminded: 0, confirmed: 0, shipped: 0 },
    email: { reminded: 0, confirmed: 0, shipped: 0 },
    voice: { reminded: 0, confirmed: 0, shipped: 0 },
  };

  let reminded = 0;
  let confirmed = 0;
  let shipped = 0;

  for (const ep of episodes) {
    const channels = channelsByEpisode.get(ep.id);
    const isConfirmed = CONFIRMED_STATUSES.has(ep.status);
    const isShipped = shippedEpisodeIds.has(ep.id);
    if (isConfirmed) confirmed += 1;
    if (isShipped) shipped += 1;
    if (channels && channels.size > 0) {
      reminded += 1;
      for (const ch of channels) {
        byChannel[ch].reminded += 1;
        if (isConfirmed) byChannel[ch].confirmed += 1;
        if (isShipped) byChannel[ch].shipped += 1;
      }
    }
  }

  return {
    due: episodes.length,
    reminded,
    confirmed,
    shipped,
    byChannel,
    rates: {
      remindedOfDue: rate(reminded, episodes.length),
      confirmedOfReminded: rate(confirmed, reminded),
      shippedOfConfirmed: rate(shipped, confirmed),
    },
  };
}

function isFunnelChannel(value: string): value is FunnelChannel {
  return (FUNNEL_CHANNELS as readonly string[]).includes(value);
}
